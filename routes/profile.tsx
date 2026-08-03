/**
 * Profile: identity, photo, and the encrypted refund IBAN.
 *
 * The IBAN is optional. It is only ever needed when a refund is owed, so the
 * form says exactly why it is asked for, requires explicit consent, and never
 * renders the stored value back — only its last four digits.
 */

import type { App } from "fresh";
import type { State } from "../main.ts";
import { Page } from "../components/Layout.tsx";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Field,
  Select,
} from "../components/ui.tsx";
import {
  CSRF_FIELD,
  csrfCookie,
  isSecureRequest,
  requireUser,
  verifyCsrf,
} from "../lib/auth/middleware.ts";
import {
  DuplicateError,
  isProfileComplete,
  updateUser,
} from "../lib/data/users.ts";
import {
  deletePhoto,
  PhotoError,
  processPhoto,
  savePhoto,
} from "../lib/data/photos.ts";
import { encryptSecret, ibanLast4, maskIban } from "../lib/crypto.ts";
import { checkinVersionOf } from "../lib/domain/checkin.ts";
import {
  isValidIban,
  normalizeIban,
  normalizePhone,
} from "../lib/domain/validate.ts";
import { nowIso } from "../lib/domain/time.ts";
import type { Skill, User } from "../lib/types.ts";
import { SKILL_ORDER } from "../lib/types.ts";

interface ProfileViewProps {
  user: User;
  csrf: string;
  error?: string;
  saved?: boolean;
  /** Something happened that is not "profile saved" — say what instead. */
  notice?: string;
  setup?: boolean;
}

function SkillOptions(props: { current: Skill }) {
  const labels: Record<Skill, string> = {
    beginner: "Beginner — still learning the basics",
    intermediate: "Intermediate — steady rallies",
    advanced: "Advanced — competitive club level",
    competitive: "Competitive — tournament player",
  };
  return (
    <>
      {SKILL_ORDER.map((skill) => (
        <option key={skill} value={skill} selected={skill === props.current}>
          {labels[skill]}
        </option>
      ))}
    </>
  );
}

function ProfileView(props: ProfileViewProps) {
  const { user, setup } = props;

  return (
    <Page user={user} nav="profile">
      <div class="max-w-xl mx-auto flex flex-col gap-6">
        <div>
          <h1 class="text-headline-lg text-on-surface">
            {setup ? "Finish your profile" : "Your profile"}
          </h1>
          {setup && (
            <p class="text-body-md text-on-surface-variant mt-2">
              We need a name and phone number before you can join a game — the
              organizer uses them on match day.
            </p>
          )}
        </div>

        {props.error && <Alert tone="error">{props.error}</Alert>}
        {props.saved && <Alert tone="success">Profile saved.</Alert>}
        {props.notice && <Alert tone="success">{props.notice}</Alert>}

        <Card>
          <form
            method="post"
            action="/profile"
            enctype="multipart/form-data"
            class="flex flex-col gap-5"
          >
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />

            <div class="flex items-center gap-4">
              <Avatar
                name={user.name || user.email}
                userId={user.id}
                hasPhoto={user.hasPhoto}
                size={72}
              />
              <div class="flex-1">
                <label
                  for="photo"
                  class="text-label font-bold text-on-surface-variant block mb-1.5"
                >
                  Profile photo
                </label>
                <input
                  id="photo"
                  name="photo"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  class="block w-full text-body-md text-on-surface-variant
                         file:mr-3 file:rounded-full file:border-0 file:bg-surface-high
                         file:px-4 file:py-2 file:text-label file:font-bold file:text-on-surface"
                />
                {user.hasPhoto && (
                  <label class="flex items-center gap-2 mt-2 text-label-sm text-on-surface-variant">
                    <input type="checkbox" name="removePhoto" value="1" />
                    Remove current photo
                  </label>
                )}
              </div>
            </div>

            <Field
              label="Full name"
              name="name"
              required
              autoComplete="name"
              value={user.name}
              placeholder="Alex Mercer"
            />

            <Field
              label="Mobile number"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              required
              value={user.phone ?? ""}
              placeholder="050 123 4567"
              hint="UAE numbers can be entered as 050…; we store the +971 form."
            />

            <Select label="Skill level" name="skill">
              <SkillOptions current={user.skill} />
            </Select>

            <Select
              label="Gender (optional)"
              name="gender"
              hint="Only used when an organizer runs balanced games."
            >
              <option value="" selected={!user.gender}>
                Prefer not to say
              </option>
              <option value="f" selected={user.gender === "f"}>Female</option>
              <option value="m" selected={user.gender === "m"}>Male</option>
              <option value="other" selected={user.gender === "other"}>
                Other
              </option>
            </Select>

            <fieldset class="border border-outline-variant rounded-lg p-4 flex flex-col gap-4">
              <legend class="text-label font-bold text-on-surface-variant px-2">
                Refund bank details (optional)
              </legend>

              <p class="text-label-sm text-on-surface-variant">
                We only use this to refund you if a game is cancelled. It is
                encrypted and only visible to your game organizer when a refund
                is being processed. You can add it later instead.
              </p>

              {user.iban && (
                <Alert tone="info">
                  Saved: {maskIban(`0000${user.iban.last4}`)} ·{" "}
                  {user.iban.holder}
                </Alert>
              )}

              <Field
                label="Account holder name"
                name="ibanHolder"
                autoComplete="cc-name"
                value={user.iban?.holder ?? ""}
                placeholder="As printed on your bank account"
              />

              <Field
                label="IBAN"
                name="iban"
                value=""
                placeholder="AE07 0331 2345 6789 0123 456"
                hint={user.iban
                  ? "Leave blank to keep the IBAN you already saved."
                  : undefined}
              />

              <label class="flex items-start gap-2 text-label-sm text-on-surface-variant">
                <input
                  type="checkbox"
                  name="ibanConsent"
                  value="1"
                  class="mt-1"
                />
                <span>
                  I consent to Smash Club storing my bank details, encrypted,
                  for refunds.
                </span>
              </label>

              {user.iban && (
                <label class="flex items-center gap-2 text-label-sm text-error">
                  <input type="checkbox" name="removeIban" value="1" />
                  Delete my saved bank details
                </label>
              )}
            </fieldset>

            <label class="flex items-center gap-2 text-body-md text-on-surface">
              <input
                type="checkbox"
                name="emailOptIn"
                value="1"
                checked={user.emailOptIn}
              />
              Email me game reminders and waitlist updates
            </label>

            <Button type="submit" fullWidth>
              {setup ? "Save and continue" : "Save profile"}
            </Button>
          </form>
        </Card>

        {!setup && (
          <Card class="flex flex-col gap-3">
            <h2 class="text-body-lg font-bold text-on-surface">
              Check-in code
            </h2>
            <p class="text-body-md text-on-surface-variant">
              Your QR code never expires, so anyone you have sent a screenshot
              to still has a working copy. Replacing it kills the old one.
            </p>
            <form method="post" action="/profile">
              <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
              <input type="hidden" name="replaceCheckinCode" value="1" />
              <Button type="submit" variant="secondary">
                Replace my check-in code
              </Button>
            </form>
          </Card>
        )}

        {!setup && (
          <form method="post" action="/auth/logout">
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <Button type="submit" variant="ghost" fullWidth>Sign out</Button>
          </form>
        )}
      </div>
    </Page>
  );
}

/** Renders the profile form and refreshes the CSRF cookie alongside it. */
interface RenderCtx {
  req: Request;
  render(node: unknown): Promise<Response>;
}

async function renderProfile(
  ctx: RenderCtx,
  props: ProfileViewProps,
): Promise<Response> {
  const response = await ctx.render(<ProfileView {...props} />);
  response.headers.append(
    "set-cookie",
    csrfCookie(props.csrf, isSecureRequest(ctx.req)),
  );
  return response;
}

export function profileRoutes(app: App<State>) {
  app.get("/profile", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const url = new URL(ctx.req.url);
    return await renderProfile(ctx, {
      user,
      csrf: ctx.state.auth.csrfToken,
      saved: url.searchParams.has("saved"),
    });
  });

  app.get("/profile/setup", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    if (isProfileComplete(user)) return ctx.redirect("/games");
    return await renderProfile(ctx, {
      user,
      csrf: ctx.state.auth.csrfToken,
      setup: true,
    });
  });

  app.post("/profile", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;
    const csrf = ctx.state.auth.csrfToken;
    const setup = !isProfileComplete(user);

    const form = await ctx.req.formData();
    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      return await renderProfile(ctx, {
        user,
        csrf,
        setup,
        error: "That form expired. Please try again.",
      });
    }

    // Handled before the profile fields are read, because this form carries
    // none of them and every check below would reject it.
    if (form.get("replaceCheckinCode")) {
      // The id comes from the session, never from the form: a player may only
      // retire their own code.
      const replaced = await updateUser(kv, user.id, {
        checkinVersion: checkinVersionOf(user) + 1,
      });

      return await renderProfile(ctx, {
        user: replaced,
        csrf,
        setup,
        notice: "Your check-in code has been replaced.",
      });
    }

    const fail = (message: string) =>
      renderProfile(ctx, { user, csrf, setup, error: message });

    const name = form.get("name")?.toString().trim() ?? "";
    if (name.length < 2) return fail("Please enter your full name.");

    const phoneRaw = form.get("phone")?.toString().trim() ?? "";
    const phone = normalizePhone(phoneRaw);
    if (!phone) return fail("That mobile number could not be understood.");

    const skill = form.get("skill")?.toString() as Skill;
    if (!SKILL_ORDER.includes(skill)) return fail("Pick a skill level.");

    const genderRaw = form.get("gender")?.toString() ?? "";
    const gender = genderRaw === "" ? undefined : genderRaw as User["gender"];

    // --- Photo ------------------------------------------------------------
    let hasPhoto = user.hasPhoto;
    if (form.get("removePhoto")) {
      await deletePhoto(kv, user.id);
      hasPhoto = false;
    } else {
      const upload = form.get("photo");
      if (upload instanceof File && upload.size > 0) {
        try {
          const bytes = await processPhoto(upload);
          await savePhoto(kv, user.id, bytes);
          hasPhoto = true;
        } catch (error) {
          if (error instanceof PhotoError) return fail(error.message);
          console.error("Photo processing failed", error);
          return fail("We could not process that image.");
        }
      }
    }

    // --- Refund IBAN ------------------------------------------------------
    let ibanUpdate: Parameters<typeof updateUser>[2]["iban"];

    if (form.get("removeIban")) {
      ibanUpdate = null;
    } else {
      const ibanRaw = form.get("iban")?.toString().trim() ?? "";
      const holder = form.get("ibanHolder")?.toString().trim() ?? "";
      const consented = form.get("ibanConsent") !== null;

      if (ibanRaw !== "") {
        if (!consented) {
          return fail("Please tick the consent box to save your bank details.");
        }
        if (!holder) {
          return fail("Add the account holder name for your IBAN.");
        }
        if (!isValidIban(ibanRaw)) {
          return fail("That IBAN is not valid. Check for a typo.");
        }

        const normalized = normalizeIban(ibanRaw);
        ibanUpdate = {
          encrypted: await encryptSecret(normalized),
          holder,
          last4: ibanLast4(normalized),
          consentAt: nowIso(),
        };
      } else if (user.iban && holder && holder !== user.iban.holder) {
        // Holder name changed without re-entering the IBAN; keep the secret.
        ibanUpdate = { ...user.iban, holder };
      }
    }

    try {
      await updateUser(kv, user.id, {
        name,
        phone,
        skill,
        gender,
        hasPhoto,
        emailOptIn: form.get("emailOptIn") !== null,
        iban: ibanUpdate,
      });
    } catch (error) {
      if (error instanceof DuplicateError) {
        return fail(
          "That mobile number is already registered to someone else.",
        );
      }
      throw error;
    }

    return ctx.redirect(setup ? "/games" : "/profile?saved=1");
  });
}
