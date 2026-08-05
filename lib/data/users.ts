/**
 * User records and their unique indexes.
 *
 * KV has no unique constraints, so email and phone uniqueness is enforced by
 * checking the index key is empty inside the same atomic commit that writes it.
 * If the commit loses the race, the value was taken.
 */

import { ulid } from "@std/ulid";
import { keys } from "../kv/keys.ts";
import { ConflictError, getRecord, listRecords, withRetry } from "../kv/kv.ts";
import type {
  PayoutDetails,
  PlatformRole,
  Skill,
  StoredIban,
  User,
} from "../types.ts";
import { normalizeEmail, normalizePhone } from "../domain/validate.ts";
import { nowIso } from "../domain/time.ts";

export class DuplicateError extends Error {
  constructor(public readonly field: "email" | "phone") {
    super(`That ${field} is already registered`);
    this.name = "DuplicateError";
  }
}

export async function getUser(
  kv: Deno.Kv,
  userId: string,
): Promise<User | null> {
  const entry = await getRecord<User>(kv, keys.user(userId));
  return entry.value;
}

export async function getUserByEmail(
  kv: Deno.Kv,
  email: string,
): Promise<User | null> {
  const pointer = await kv.get<string>(keys.userByEmail(normalizeEmail(email)));
  if (!pointer.value) return null;
  return await getUser(kv, pointer.value);
}

export async function getUserByPhone(
  kv: Deno.Kv,
  phone: string,
): Promise<User | null> {
  const e164 = normalizePhone(phone);
  if (!e164) return null;
  const pointer = await kv.get<string>(keys.userByPhone(e164));
  if (!pointer.value) return null;
  return await getUser(kv, pointer.value);
}

export interface CreateUserInput {
  email: string;
  name: string;
  skill?: Skill;
  phone?: string;
  role?: PlatformRole;
}

/**
 * Creates a user, reserving the email index in the same commit.
 * Throws DuplicateError if the address was claimed first.
 */
export async function createUser(
  kv: Deno.Kv,
  input: CreateUserInput,
): Promise<User> {
  const emailLower = normalizeEmail(input.email);
  const phone = input.phone
    ? normalizePhone(input.phone) ?? undefined
    : undefined;
  const now = nowIso();

  const user: User = {
    v: 1,
    id: ulid(),
    email: input.email.trim(),
    emailLower,
    name: input.name.trim(),
    phone,
    skill: input.skill ?? "beginner",
    hasPhoto: false,
    role: input.role ?? "player",
    emailOptIn: true,
    createdAt: now,
    updatedAt: now,
  };

  let op = kv.atomic()
    .check({ key: keys.userByEmail(emailLower), versionstamp: null })
    .set(keys.user(user.id), user)
    .set(keys.userByEmail(emailLower), user.id);

  if (phone) {
    op = op
      .check({ key: keys.userByPhone(phone), versionstamp: null })
      .set(keys.userByPhone(phone), user.id);
  }

  const result = await op.commit();
  if (!result.ok) {
    // Work out which index was taken so the form can point at the right field.
    const existingEmail = await kv.get(keys.userByEmail(emailLower));
    if (existingEmail.value !== null) throw new DuplicateError("email");
    throw new DuplicateError("phone");
  }

  return user;
}

/** Finds an existing user by email, or creates one. Used by magic-link login. */
export async function findOrCreateUser(
  kv: Deno.Kv,
  email: string,
): Promise<{ user: User; created: boolean }> {
  const existing = await getUserByEmail(kv, email);
  if (existing) return { user: existing, created: false };

  const superAdminEmail = Deno.env.get("SUPER_ADMIN_EMAIL");
  const isSuperAdmin = superAdminEmail !== undefined &&
    normalizeEmail(superAdminEmail) === normalizeEmail(email);

  try {
    const user = await createUser(kv, {
      email,
      // Name is empty until the profile is completed; onboarding requires it.
      name: "",
      role: isSuperAdmin ? "super_admin" : "player",
    });
    return { user, created: true };
  } catch (error) {
    // Another request created the same user between our read and write.
    if (error instanceof DuplicateError) {
      const raced = await getUserByEmail(kv, email);
      if (raced) return { user: raced, created: false };
    }
    throw error;
  }
}

export interface ProfileUpdate {
  name?: string;
  phone?: string | null;
  skill?: Skill;
  gender?: User["gender"];
  emailOptIn?: boolean;
  hasPhoto?: boolean;
  iban?: StoredIban | null;
  /** Null clears it; undefined leaves whatever is stored alone. */
  payout?: PayoutDetails | null;
  checkinVersion?: number;
}

/**
 * Updates a profile, moving the phone index when the number changes.
 * The whole update is one atomic commit, so a failed phone reservation cannot
 * leave the user record half-updated.
 */
export async function updateUser(
  kv: Deno.Kv,
  userId: string,
  update: ProfileUpdate,
): Promise<User> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<User>(kv, keys.user(userId));
    const current = entry.value;
    if (!current) throw new Error(`User ${userId} not found`);

    const next: User = { ...current, updatedAt: nowIso() };

    if (update.name !== undefined) next.name = update.name.trim();
    if (update.skill !== undefined) next.skill = update.skill;
    if (update.gender !== undefined) next.gender = update.gender;
    if (update.emailOptIn !== undefined) next.emailOptIn = update.emailOptIn;
    if (update.hasPhoto !== undefined) next.hasPhoto = update.hasPhoto;
    if (update.iban !== undefined) {
      next.iban = update.iban === null ? undefined : update.iban;
    }
    if (update.payout !== undefined) {
      next.payout = update.payout === null ? undefined : update.payout;
    }
    if (update.checkinVersion !== undefined) {
      next.checkinVersion = update.checkinVersion;
    }

    let op = kv.atomic().check(entry).set(keys.user(userId), next);

    if (update.phone !== undefined) {
      const nextPhone = update.phone === null || update.phone === ""
        ? undefined
        : normalizePhone(update.phone) ?? undefined;

      if (update.phone && !nextPhone) {
        throw new Error("That phone number could not be understood");
      }

      if (nextPhone !== current.phone) {
        if (current.phone) op = op.delete(keys.userByPhone(current.phone));
        if (nextPhone) {
          const taken = await kv.get<string>(keys.userByPhone(nextPhone));
          if (taken.value && taken.value !== userId) {
            throw new DuplicateError("phone");
          }
          op = op
            .check({ key: keys.userByPhone(nextPhone), versionstamp: null })
            .set(keys.userByPhone(nextPhone), userId);
        }
        next.phone = nextPhone;
        op = op.set(keys.user(userId), next);
      }
    }

    return { op, result: next };
  });

  if (!result) throw new ConflictError("Profile update did not apply");
  return result;
}

export async function setPlatformRole(
  kv: Deno.Kv,
  userId: string,
  role: PlatformRole,
): Promise<User> {
  const result = await withRetry(kv, async (kv) => {
    const entry = await getRecord<User>(kv, keys.user(userId));
    if (!entry.value) throw new Error(`User ${userId} not found`);
    const next: User = { ...entry.value, role, updatedAt: nowIso() };
    return {
      op: kv.atomic().check(entry).set(keys.user(userId), next),
      result: next,
    };
  });
  if (!result) throw new ConflictError("Role change did not apply");
  return result;
}

/** True once the user has supplied the details every RSVP needs. */
export function isProfileComplete(user: User): boolean {
  return user.name.trim().length > 0 && user.phone !== undefined;
}

export async function listUsers(
  kv: Deno.Kv,
  limit = 100,
): Promise<User[]> {
  const rows = await listRecords<User>(kv, { prefix: ["user"] }, { limit });
  return rows.map((r) => r.value);
}
