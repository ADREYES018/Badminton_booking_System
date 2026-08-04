/**
 * Organizer game management: create, edit, cancel.
 *
 * Kept apart from `routes/game.tsx` because the guard differs — everything
 * here requires organizer rights over the group, and having that visible in
 * one file is worth more than sharing a little markup with the player views.
 *
 * Times are entered in Dubai local time, since that is where the games are,
 * and stored UTC.
 */

import type { App } from "fresh";
import type { ComponentChildren } from "preact";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { Alert, Button, Card, Field, Select } from "../../components/ui.tsx";
import GameTimeFields from "../../islands/GameTimeFields.tsx";
import {
  assertOrganizer,
  clientIp,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  resolveGroupAccess,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import {
  affectsCutoff,
  cancelGame,
  createGame,
  getGameBySlug,
  updateGame,
} from "../../lib/data/games.ts";
import { audit } from "../../lib/data/audit.ts";
import { enqueueCutoffFreeze } from "../../lib/queue/messages.ts";
import { aedToFils } from "../../lib/domain/money.ts";
import { APP_TIMEZONE, cutoffAt } from "../../lib/domain/time.ts";
import { cleanText } from "../../lib/domain/validate.ts";
import { SKILL_ORDER } from "../../lib/types.ts";
import type { Game, GameVisibility, Skill, User } from "../../lib/types.ts";

interface FormProps {
  user: User;
  csrf: string;
  groupSlug: string;
  game?: Game;
  error?: string;
  values?: Record<string, string>;
}

/**
 * Dubai is UTC+4 with no daylight saving, but the offset is derived rather
 * than hardcoded so this keeps working if that ever changes.
 */
function dubaiOffsetMs(at: Date): number {
  const local = new Date(
    at.toLocaleString("en-US", { timeZone: APP_TIMEZONE }),
  );
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}

/** Turns a `datetime-local` value, entered in Dubai time, into a UTC instant. */
export function dubaiLocalToUtc(value: string): string | null {
  if (!value) return null;
  // Interpreted as UTC first, then shifted back by Dubai's offset.
  const naive = new Date(`${value}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  return new Date(naive.getTime() - dubaiOffsetMs(naive)).toISOString();
}

/** The inverse, for populating the edit form. */
export function utcToDubaiLocal(iso: string): string {
  const at = new Date(iso);
  const shifted = new Date(at.getTime() + dubaiOffsetMs(at));
  return shifted.toISOString().slice(0, 16);
}

/**
 * One group of related fields.
 *
 * The form asks for twelve things, which as a flat column reads as a wall and
 * gives no sense of how much is left. Grouping them into four named cards
 * turns it into four small decisions — what and where, when, how big, who —
 * and lets a heading carry the explanation that would otherwise be a hint
 * repeated on every field inside it.
 */
function Section(
  props: {
    title: string;
    description?: string;
    children: ComponentChildren;
  },
) {
  return (
    <Card class="flex flex-col gap-5">
      <div class="flex flex-col gap-1">
        <h2 class="text-body-lg font-bold text-on-surface">{props.title}</h2>
        {props.description && (
          <p class="text-label-sm text-on-surface-variant">
            {props.description}
          </p>
        )}
      </div>
      {props.children}
    </Card>
  );
}

function GameForm(props: FormProps) {
  const { game, groupSlug, values = {} } = props;
  const editing = game !== undefined;
  const field = (name: string, fallback: string) => values[name] ?? fallback;

  return (
    <Page user={props.user} nav="games" groupSlug={groupSlug}>
      <div class="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <a
            href={editing ? `/games/${game.slug}` : `/g/${groupSlug}/games`}
            class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
          >
            ← Back
          </a>
          <h1 class="text-headline-lg font-headline text-on-surface mt-2">
            {editing ? "Edit game" : "New game"}
          </h1>
        </div>

        {props.error && <Alert tone="error">{props.error}</Alert>}

        <form
          method="post"
          action={editing
            ? `/g/${groupSlug}/organizer/games/${game.slug}`
            : `/g/${groupSlug}/organizer/games`}
          class="flex flex-col gap-5"
        >
          <input type="hidden" name={CSRF_FIELD} value={props.csrf} />

          <Section
            title="What and where"
            description="The three things a player reads first."
          >
            <Field
              label="Title"
              name="title"
              required
              maxLength={80}
              value={field("title", game?.title ?? "")}
              placeholder="Sunday Doubles"
            />

            <Field
              label="Venue name"
              name="venueName"
              required
              maxLength={80}
              value={field("venueName", game?.venue.name ?? "")}
              placeholder="Al Nasr Leisureland"
            />

            <Field
              label="Venue address"
              name="venueAddress"
              required
              maxLength={200}
              value={field("venueAddress", game?.venue.address ?? "")}
              placeholder="Oud Metha, Dubai"
              hint="Players tap this to open Maps, so make it findable."
            />
          </Section>

          <Section title="When">
            <GameTimeFields
              startValue={field(
                "start",
                game ? utcToDubaiLocal(game.startUtc) : "",
              )}
              endValue={field("end", game ? utcToDubaiLocal(game.endUtc) : "")}
            />

            <Field
              label="Free cancellation until"
              name="cutoffHours"
              type="number"
              min={0}
              max={336}
              required
              value={field("cutoffHours", String(game?.cutoffHours ?? 48))}
              hint="Hours before the start. After this the roster closes and nobody can drop out for free."
            />
          </Section>

          <Section
            title="Size and cost"
            description="Capacity is courts × players per court."
          >
            <div class="grid gap-5 sm:grid-cols-2">
              <Field
                label="Courts"
                name="courts"
                type="number"
                min={1}
                max={20}
                required
                value={field("courts", String(game?.courts ?? 2))}
              />
              <Field
                label="Players per court"
                name="playersPerCourt"
                type="number"
                min={2}
                max={12}
                required
                value={field(
                  "playersPerCourt",
                  String(game?.playersPerCourt ?? 4),
                )}
                hint="Doubles is 4."
              />
            </div>

            <div class="grid gap-5 sm:grid-cols-2">
              <Field
                label="Price per player (AED)"
                name="pricePerPlayer"
                type="number"
                min={0}
                step="0.01"
                required
                value={field(
                  "pricePerPlayer",
                  game ? String(game.pricePerPlayerFils / 100) : "",
                )}
                placeholder="30"
                hint="Every seat pays this, guests included."
              />
              <Field
                label="Guests per player"
                name="maxGuests"
                type="number"
                min={0}
                max={4}
                required
                value={field(
                  "maxGuests",
                  String(game?.maxGuestsPerPlayer ?? 1),
                )}
                hint="0 turns guests off. A guest takes a real seat."
              />
            </div>
          </Section>

          <Section
            title="Who can play"
            description="Skill is guidance, not a barrier — a player outside the range is warned but can still join."
          >
            <div class="grid gap-5 sm:grid-cols-2">
              <Select label="Minimum skill" name="skillMin">
                <option value="" selected={!game?.skillMin}>Any</option>
                {SKILL_ORDER.map((skill) => (
                  <option
                    key={skill}
                    value={skill}
                    selected={game?.skillMin === skill}
                  >
                    {skill}
                  </option>
                ))}
              </Select>
              <Select label="Maximum skill" name="skillMax">
                <option value="" selected={!game?.skillMax}>Any</option>
                {SKILL_ORDER.map((skill) => (
                  <option
                    key={skill}
                    value={skill}
                    selected={game?.skillMax === skill}
                  >
                    {skill}
                  </option>
                ))}
              </Select>
            </div>

            <Select
              label="Visibility"
              name="visibility"
            >
              <option
                value="public"
                selected={!game || game.visibility === "public"}
              >
                Public — anyone can find it and join
              </option>
              <option
                value="password"
                selected={game?.visibility === "password"}
              >
                Listed, but a six-digit code is needed to join
              </option>
              <option
                value="unlisted"
                selected={game?.visibility === "unlisted"}
              >
                Unlisted — only people with the link
              </option>
            </Select>

            {game?.visibility === "password" && game.joinCode && (
              <div class="flex flex-col gap-1 rounded-lg bg-surface-container px-4 py-3">
                <span class="text-label font-bold text-on-surface-variant">
                  Join code
                </span>
                <span class="text-headline-md font-headline text-on-surface tabular-nums tracking-[0.2em]">
                  {game.joinCode}
                </span>
                <span class="text-label-sm text-on-surface-variant">
                  Share this with the players you want in. Anyone can see the
                  game; only this code lets them take a seat.
                </span>
              </div>
            )}
          </Section>

          <Button type="submit" fullWidth>
            {editing ? "Save changes" : "Post this game"}
          </Button>
        </form>

        {editing && game.status !== "cancelled" && (
          <Card>
            <form
              method="post"
              action={`/g/${groupSlug}/organizer/games/${game.slug}/cancel`}
              class="flex flex-col gap-3"
            >
              <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
              <h2 class="text-body-lg font-bold text-on-surface">
                Cancel this game
              </h2>
              <p class="text-label-sm text-on-surface-variant">
                Everyone on the roster keeps their record so you can sort out
                refunds. The game stops accepting sign-ups immediately.
              </p>
              <Field
                label="Reason"
                name="reason"
                required
                maxLength={140}
                placeholder="Court double-booked"
              />
              <Button type="submit" variant="danger">Cancel game</Button>
            </form>
          </Card>
        )}
      </div>
    </Page>
  );
}

interface ParsedGame {
  title: string;
  venueName: string;
  venueAddress: string;
  startUtc: string;
  endUtc: string;
  courts: number;
  playersPerCourt: number;
  pricePerPlayerFils: number;
  maxGuestsPerPlayer: number;
  cutoffHours: number;
  skillMin?: Skill;
  skillMax?: Skill;
  visibility: GameVisibility;
}

/** Validates the form. Returns either the parsed game or a message to show. */
function parseForm(form: FormData): ParsedGame | { error: string } {
  const title = cleanText(form.get("title")?.toString() ?? "", 80);
  if (title.length < 3) return { error: "Give the game a title." };

  const venueName = cleanText(form.get("venueName")?.toString() ?? "", 80);
  const venueAddress = cleanText(
    form.get("venueAddress")?.toString() ?? "",
    200,
  );
  if (!venueName || !venueAddress) {
    return { error: "Add the venue name and address." };
  }

  const startUtc = dubaiLocalToUtc(form.get("start")?.toString() ?? "");
  const endUtc = dubaiLocalToUtc(form.get("end")?.toString() ?? "");
  if (!startUtc || !endUtc) return { error: "Check the start and end times." };
  if (new Date(endUtc) <= new Date(startUtc)) {
    return { error: "The game has to end after it starts." };
  }

  const courts = Number(form.get("courts"));
  const playersPerCourt = Number(form.get("playersPerCourt"));
  if (!Number.isInteger(courts) || courts < 1) {
    return { error: "Courts must be a whole number, at least one." };
  }
  if (!Number.isInteger(playersPerCourt) || playersPerCourt < 2) {
    return { error: "A court needs at least two players." };
  }

  const pricePerPlayer = Number(form.get("pricePerPlayer"));
  if (!Number.isFinite(pricePerPlayer) || pricePerPlayer < 0) {
    return { error: "Check the price per player." };
  }

  const maxGuestsPerPlayer = Number(form.get("maxGuests"));
  if (!Number.isInteger(maxGuestsPerPlayer) || maxGuestsPerPlayer < 0) {
    return { error: "Guests per player must be zero or more." };
  }

  const cutoffHours = Number(form.get("cutoffHours"));
  if (!Number.isInteger(cutoffHours) || cutoffHours < 0) {
    return { error: "The cutoff must be a whole number of hours." };
  }

  const skillMinRaw = form.get("skillMin")?.toString() ?? "";
  const skillMaxRaw = form.get("skillMax")?.toString() ?? "";
  const skillMin = SKILL_ORDER.includes(skillMinRaw as Skill)
    ? skillMinRaw as Skill
    : undefined;
  const skillMax = SKILL_ORDER.includes(skillMaxRaw as Skill)
    ? skillMaxRaw as Skill
    : undefined;

  if (
    skillMin && skillMax &&
    SKILL_ORDER.indexOf(skillMin) > SKILL_ORDER.indexOf(skillMax)
  ) {
    return { error: "The minimum skill is above the maximum." };
  }

  const visibilityRaw = form.get("visibility")?.toString() ?? "";
  const visibility: GameVisibility =
    visibilityRaw === "unlisted" || visibilityRaw === "password"
      ? visibilityRaw
      : "public";

  return {
    title,
    venueName,
    venueAddress,
    startUtc,
    endUtc,
    courts,
    playersPerCourt,
    pricePerPlayerFils: aedToFils(pricePerPlayer),
    maxGuestsPerPlayer,
    cutoffHours,
    skillMin,
    skillMax,
    visibility,
  };
}

function formValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string" && key !== CSRF_FIELD) values[key] = value;
  }
  return values;
}

/** The club named in the URL, and proof the caller may administer it. */
async function organizerContext(state: State, groupSlug: string) {
  const access = assertOrganizer(
    await resolveGroupAccess(state.auth, groupSlug),
  );
  return {
    user: access.user,
    kv: state.auth.kv,
    group: access.group,
    access,
  };
}

/**
 * Loads a game and refuses one that belongs to another club.
 *
 * Game slugs are unique across the whole app, so without this check an
 * organizer could reach any club's game by putting their own club in the URL.
 * A game in someone else's club is not theirs to see, so this is a 404 rather
 * than a 403.
 */
async function gameInGroup(kv: Deno.Kv, groupId: string, slug: string) {
  const game = await getGameBySlug(kv, slug);
  if (!game || game.groupId !== groupId) {
    throw new HttpError(404, "That game could not be found");
  }
  return game;
}

export function organizerGameRoutes(app: App<State>) {
  app.get("/g/:groupSlug/organizer/games/new", async (ctx) => {
    const { user, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const response = await ctx.render(
      <GameForm
        user={user}
        csrf={ctx.state.auth.csrfToken}
        groupSlug={group.slug}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/g/:groupSlug/organizer/games", async (ctx) => {
    const { user, kv, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const parsed = parseForm(form);
    if ("error" in parsed) {
      return await ctx.render(
        <GameForm
          user={user}
          csrf={ctx.state.auth.csrfToken}
          groupSlug={group.slug}
          error={parsed.error}
          values={formValues(form)}
        />,
      );
    }

    const game = await createGame(kv, {
      groupId: group.id,
      title: parsed.title,
      venue: { name: parsed.venueName, address: parsed.venueAddress },
      startUtc: parsed.startUtc,
      endUtc: parsed.endUtc,
      courts: parsed.courts,
      playersPerCourt: parsed.playersPerCourt,
      pricePerPlayerFils: parsed.pricePerPlayerFils,
      maxGuestsPerPlayer: parsed.maxGuestsPerPlayer,
      cutoffHours: parsed.cutoffHours,
      skillMin: parsed.skillMin,
      skillMax: parsed.skillMax,
      visibility: parsed.visibility,
      createdBy: user.id,
    });

    // Freeze the roster and lock the cost when the cutoff arrives.
    await enqueueCutoffFreeze(
      kv,
      game.id,
      cutoffAt(game.startUtc, game.cutoffHours).toISOString(),
    );

    await audit(kv, {
      actorId: user.id,
      action: "game.created",
      targetId: game.id,
      groupId: group.id,
      after: { title: game.title, startUtc: game.startUtc },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/games/${game.slug}`);
  });

  app.get("/g/:groupSlug/organizer/games/:slug/edit", async (ctx) => {
    const { user, kv, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const game = await gameInGroup(kv, group.id, ctx.params.slug!);

    const response = await ctx.render(
      <GameForm
        user={user}
        csrf={ctx.state.auth.csrfToken}
        groupSlug={group.slug}
        game={game}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/g/:groupSlug/organizer/games/:slug", async (ctx) => {
    const { user, kv, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const game = await gameInGroup(kv, group.id, ctx.params.slug!);

    const parsed = parseForm(form);
    if ("error" in parsed) {
      return await ctx.render(
        <GameForm
          user={user}
          csrf={ctx.state.auth.csrfToken}
          groupSlug={group.slug}
          game={game}
          error={parsed.error}
          values={formValues(form)}
        />,
      );
    }

    const update = {
      title: parsed.title,
      venue: { name: parsed.venueName, address: parsed.venueAddress },
      startUtc: parsed.startUtc,
      endUtc: parsed.endUtc,
      courts: parsed.courts,
      playersPerCourt: parsed.playersPerCourt,
      pricePerPlayerFils: parsed.pricePerPlayerFils,
      maxGuestsPerPlayer: parsed.maxGuestsPerPlayer,
      cutoffHours: parsed.cutoffHours,
      skillMin: parsed.skillMin ?? null,
      skillMax: parsed.skillMax ?? null,
      visibility: parsed.visibility,
    };

    const updated = await updateGame(kv, game.id, update);

    // KV queues cannot cancel a scheduled message, so a moved cutoff means
    // another one. The earlier message fires, finds the cutoff has not
    // arrived, and reschedules itself rather than freezing early.
    if (affectsCutoff(update)) {
      await enqueueCutoffFreeze(
        kv,
        updated.id,
        cutoffAt(updated.startUtc, updated.cutoffHours).toISOString(),
      );
    }

    await audit(kv, {
      actorId: user.id,
      action: "game.updated",
      targetId: game.id,
      groupId: group.id,
      before: {
        startUtc: game.startUtc,
        pricePerPlayerFils: game.pricePerPlayerFils,
      },
      after: {
        startUtc: updated.startUtc,
        pricePerPlayerFils: updated.pricePerPlayerFils,
      },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/games/${updated.slug}`);
  });

  app.post("/g/:groupSlug/organizer/games/:slug/cancel", async (ctx) => {
    const { user, kv, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const game = await gameInGroup(kv, group.id, ctx.params.slug!);

    const reason = cleanText(form.get("reason")?.toString() ?? "", 140);
    if (reason.length < 3) {
      return await ctx.render(
        <GameForm
          user={user}
          csrf={ctx.state.auth.csrfToken}
          groupSlug={group.slug}
          game={game}
          error="Say why the game is off — everyone on the roster will see it."
        />,
      );
    }

    await cancelGame(kv, game.id, reason);
    await audit(kv, {
      actorId: user.id,
      action: "game.cancelled",
      targetId: game.id,
      groupId: group.id,
      after: { reason },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/games/${game.slug}`);
  });
}
