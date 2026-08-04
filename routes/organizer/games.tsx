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
  requireGameOrganizer,
  requireUser,
  resolveGroupAccess,
  verifyCsrf,
} from "../../lib/auth/middleware.ts";
import {
  affectsCutoff,
  cancelGame,
  createGame,
  deleteGame,
  getGameBySlug,
  updateGame,
} from "../../lib/data/games.ts";
import { audit } from "../../lib/data/audit.ts";
import { enqueueCutoffFreeze } from "../../lib/queue/messages.ts";
import { aedToFils } from "../../lib/domain/money.ts";
import { APP_TIMEZONE, cutoffAt } from "../../lib/domain/time.ts";
import { cleanText } from "../../lib/domain/validate.ts";
import {
  DEFAULT_SPORT,
  isSport,
  SKILL_ORDER,
  SPORT_LABELS,
  SPORTS,
} from "../../lib/types.ts";
import type {
  Game,
  GameVisibility,
  Skill,
  Sport,
  User,
} from "../../lib/types.ts";

interface FormProps {
  user: User;
  csrf: string;
  /**
   * The club the game is posted into. Absent for a clubless game, which posts
   * to `/games/new` and belongs to whoever created it.
   */
  groupSlug?: string;
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

  // A club's games post and edit under that club; a clubless game uses the
  // bare paths, which check the creator instead of a membership. The two sets
  // are otherwise the same form.
  const base = groupSlug ? `/g/${groupSlug}/organizer/games` : "/games";
  const action = editing ? `${base}/${game.slug}` : base;
  const backHref = editing
    ? `/games/${game.slug}`
    : groupSlug
    ? `/g/${groupSlug}/games`
    : "/games";

  return (
    <Page user={props.user} nav="games" groupSlug={groupSlug}>
      <div class="max-w-2xl mx-auto flex flex-col gap-6">
        <div>
          <a
            href={backHref}
            class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors"
          >
            ← Back
          </a>
          <h1 class="text-headline-lg font-headline text-on-surface mt-2">
            {editing ? "Edit game" : "New game"}
          </h1>
          {!editing && !groupSlug && (
            <p class="text-body-md text-on-surface-variant mt-1">
              This game is yours rather than a club's. You run it, and anyone
              with the link can join.
            </p>
          )}
        </div>

        {props.error && <Alert tone="error">{props.error}</Alert>}

        <form
          method="post"
          action={action}
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

            <Select label="Sport" name="sport">
              {SPORTS.map((sport) => (
                <option
                  key={sport}
                  value={sport}
                  selected={(values.sport ?? game?.sport ?? DEFAULT_SPORT) ===
                    sport}
                >
                  {SPORT_LABELS[sport]}
                </option>
              ))}
            </Select>

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
            description="How many can play, and what a seat costs."
          >
            <div class="grid gap-5 sm:grid-cols-2">
              <Field
                label="Players"
                name="maxPlayers"
                type="number"
                min={2}
                max={200}
                required
                value={field("maxPlayers", String(game?.maxPlayers ?? 8))}
                hint="Total spots on the roster. Guests take one each."
              />
              <Field
                label="Courts"
                name="courts"
                type="number"
                min={1}
                max={20}
                required
                value={field("courts", String(game?.courts ?? 2))}
                hint="How many you have booked."
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
              action={`${base}/${game.slug}/cancel`}
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

        {
          /*
          Deleting is kept apart from cancelling and worded to say which is
          probably wanted: cancelling tells the roster, deleting hides the game
          from them. The confirmation is on the submit itself rather than a
          typed phrase, because the roster and the money behind it survive
          either way — this is recoverable in the sense that matters.
        */
        }
        {editing && (
          <Card>
            <form
              method="post"
              action={`${base}/${game.slug}/delete`}
              class="flex flex-col gap-3"
            >
              <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
              <h2 class="text-body-lg font-bold text-on-surface">
                Delete this game
              </h2>
              <p class="text-label-sm text-on-surface-variant">
                Removes it from the listings and from your games. Nobody will be
                able to open it. The roster, attendance and any payments are
                kept — if players need telling, cancel it instead.
              </p>
              <Button type="submit" variant="danger">Delete game</Button>
            </form>
          </Card>
        )}
      </div>
    </Page>
  );
}

interface ParsedGame {
  title: string;
  sport: Sport;
  venueName: string;
  venueAddress: string;
  startUtc: string;
  endUtc: string;
  courts: number;
  maxPlayers: number;
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

  // An unrecognised value means a tampered or stale form rather than a choice
  // worth refusing over, so it falls back rather than erroring.
  const sportRaw = form.get("sport")?.toString() ?? "";
  const sport: Sport = isSport(sportRaw) ? sportRaw : DEFAULT_SPORT;

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
  const maxPlayers = Number(form.get("maxPlayers"));
  if (!Number.isInteger(courts) || courts < 1) {
    return { error: "Courts must be a whole number, at least one." };
  }
  if (!Number.isInteger(maxPlayers) || maxPlayers < 2) {
    return { error: "A game needs room for at least two players." };
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
    sport,
    venueName,
    venueAddress,
    startUtc,
    endUtc,
    courts,
    maxPlayers,
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

/**
 * Who is acting, and on which game, for the club-free routes.
 *
 * The club routes prove the caller may administer the club and then find the
 * game inside it. There is no club here, so the game is found first and the
 * rights are read off the game itself — its creator, or a super_admin.
 *
 * These routes serve club games too, which is what makes a single "edit this
 * game" link work from the game page without knowing which kind it is. The
 * guard is the same either way: `requireGameOrganizer` consults the club when
 * there is one.
 */
async function gameContext(state: State, slug: string) {
  const kv = state.auth.kv;
  const game = await getGameBySlug(kv, slug);
  if (!game) throw new HttpError(404, "That game could not be found");

  const access = await requireGameOrganizer(state.auth, game);
  return { user: access.user, kv, game, group: access.group };
}

/**
 * The Fresh context these handlers need.
 *
 * Spelled out rather than inferred because the same handler is registered on
 * two URL shapes, and a shared handler cannot take its type from one of them.
 */
interface EditCtx {
  req: Request;
  params: Record<string, string | undefined>;
  state: State;
  render: (node: preact.VNode) => Promise<Response>;
  redirect: (to: string) => Response;
}

/**
 * Creates the game, schedules its cutoff freeze, records it, and sends the
 * organizer to it.
 *
 * Shared by the club and clubless create routes, which differ only in the
 * `groupId` they pass and the rights they checked before getting here.
 */
async function postGame(
  ctx: EditCtx,
  kv: Deno.Kv,
  user: User,
  groupId: string | null,
  parsed: ParsedGame,
): Promise<Response> {
  const game = await createGame(kv, {
    groupId,
    title: parsed.title,
    sport: parsed.sport,
    venue: { name: parsed.venueName, address: parsed.venueAddress },
    startUtc: parsed.startUtc,
    endUtc: parsed.endUtc,
    courts: parsed.courts,
    maxPlayers: parsed.maxPlayers,
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
    groupId,
    after: { title: game.title, startUtc: game.startUtc },
    ip: clientIp(ctx.req),
  });

  // `posted=1` raises the confirmation on the page they land on. It rides on
  // the redirect rather than being inferred from anything on the record, so
  // a reload drops it and the organizer is congratulated once.
  return ctx.redirect(`/games/${game.slug}?posted=1`);
}

/** The edit form, with the CSRF cookie the form's own POST will check. */
async function renderEditForm(
  ctx: EditCtx,
  user: User,
  game: Game,
  groupSlug: string | undefined,
): Promise<Response> {
  const response = await ctx.render(
    <GameForm
      user={user}
      csrf={ctx.state.auth.csrfToken}
      groupSlug={groupSlug}
      game={game}
    />,
  );
  response.headers.append(
    "set-cookie",
    csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
  );
  return response;
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

    return await postGame(ctx, kv, user, group.id, parsed);
  });

  /**
   * Posting a game that belongs to nobody.
   *
   * The one route here that does not check organizer rights at all: anyone
   * signed in may post a game, and doing so makes them its organizer. Playing
   * badminton with friends does not require founding a club first.
   */
  app.get("/games/new", async (ctx) => {
    const user = requireUser(ctx.state.auth);

    const response = await ctx.render(
      <GameForm user={user} csrf={ctx.state.auth.csrfToken} />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });

  app.post("/games", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;
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
          error={parsed.error}
          values={formValues(form)}
        />,
      );
    }

    return await postGame(ctx, kv, user, null, parsed);
  });

  // ---- Edit, cancel and delete -------------------------------------------
  //
  // Registered on both shapes. The club paths are what the club's own screens
  // link to; the bare paths are what the game page links to, since it has one
  // link to offer whether or not the game has a club. Both end in the same
  // handler, and both are guarded by `requireGameOrganizer`.

  app.get("/games/:slug/edit", async (ctx) => {
    const { user, game, group } = await gameContext(
      ctx.state,
      ctx.params.slug!,
    );
    return await renderEditForm(ctx, user, game, group?.slug);
  });

  app.get("/g/:groupSlug/organizer/games/:slug/edit", async (ctx) => {
    const { user, kv, group } = await organizerContext(
      ctx.state,
      ctx.params.groupSlug!,
    );
    const game = await gameInGroup(kv, group.id, ctx.params.slug!);
    return await renderEditForm(ctx, user, game, group.slug);
  });

  const saveEdit = async (ctx: EditCtx, groupSlug?: string) => {
    const { user, kv, game, group } = await gameContext(
      ctx.state,
      ctx.params.slug!,
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
          groupSlug={groupSlug ?? group?.slug}
          game={game}
          error={parsed.error}
          values={formValues(form)}
        />,
      );
    }

    const update = {
      title: parsed.title,
      sport: parsed.sport,
      venue: { name: parsed.venueName, address: parsed.venueAddress },
      startUtc: parsed.startUtc,
      endUtc: parsed.endUtc,
      courts: parsed.courts,
      maxPlayers: parsed.maxPlayers,
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
      groupId: game.groupId,
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
  };

  app.post("/games/:slug", (ctx) => saveEdit(ctx));
  app.post(
    "/g/:groupSlug/organizer/games/:slug",
    (ctx) => saveEdit(ctx, ctx.params.groupSlug!),
  );

  const cancel = async (ctx: EditCtx, groupSlug?: string) => {
    const { user, kv, game, group } = await gameContext(
      ctx.state,
      ctx.params.slug!,
    );
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    const reason = cleanText(form.get("reason")?.toString() ?? "", 140);
    if (reason.length < 3) {
      return await ctx.render(
        <GameForm
          user={user}
          csrf={ctx.state.auth.csrfToken}
          groupSlug={groupSlug ?? group?.slug}
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
      groupId: game.groupId,
      after: { reason },
      ip: clientIp(ctx.req),
    });

    return ctx.redirect(`/games/${game.slug}`);
  };

  app.post("/games/:slug/cancel", (ctx) => cancel(ctx));
  app.post(
    "/g/:groupSlug/organizer/games/:slug/cancel",
    (ctx) => cancel(ctx, ctx.params.groupSlug!),
  );

  /**
   * Deleting a game.
   *
   * Hides it everywhere and keeps every record behind it; see `deleteGame`.
   * The organizer lands back on whichever listing the game came from, since
   * the game page they were on no longer resolves.
   */
  const remove = async (ctx: EditCtx) => {
    const { user, kv, game, group } = await gameContext(
      ctx.state,
      ctx.params.slug!,
    );
    const form = await ctx.req.formData();

    if (!verifyCsrf(ctx.req, form.get(CSRF_FIELD)?.toString() ?? null)) {
      throw new HttpError(403, "That form expired. Please try again.");
    }

    await deleteGame(kv, game.id, user.id);
    await audit(kv, {
      actorId: user.id,
      action: "game.deleted",
      targetId: game.id,
      groupId: game.groupId,
      before: { title: game.title, startUtc: game.startUtc },
      ip: clientIp(ctx.req),
    });

    const back = group ? `/g/${group.slug}/games` : "/games";
    return ctx.redirect(
      `${back}?notice=${encodeURIComponent("Game deleted.")}`,
    );
  };

  app.post("/games/:slug/delete", remove);
  app.post("/g/:groupSlug/organizer/games/:slug/delete", remove);
}
