/**
 * What a game cost, what has come in, and who still owes.
 *
 * The prominent figure is **outstanding**, not collected. `marked_paid` is a
 * player's word and counts as outstanding until the organizer confirms it, so
 * "how much am I still out of pocket" is the number that must not be
 * optimistic — and therefore the one shown largest.
 */

import type { App } from "fresh";
import type { State } from "../../main.ts";
import { Page } from "../../components/Layout.tsx";
import { Alert, Avatar, Button, Card } from "../../components/ui.tsx";
import { PaymentStateChip } from "../../components/PaymentPanel.tsx";
import {
  assertOrganizer,
  CSRF_FIELD,
  csrfCookie,
  HttpError,
  isSecureRequest,
  requireUser,
  resolveGroupAccess,
} from "../../lib/auth/middleware.ts";
import { getGameBySlug } from "../../lib/data/games.ts";
import {
  listRoster,
  type Settlement,
  settlementFor,
} from "../../lib/data/signups.ts";
import { getUser } from "../../lib/data/users.ts";
import { amountOwed, formatFils } from "../../lib/domain/money.ts";
import { formatGameTime } from "../../lib/domain/time.ts";
import type { Game, Signup, User } from "../../lib/types.ts";

interface Row {
  signup: Signup;
  user: User | null;
}

interface SettlementProps {
  user: User;
  game: Game;
  settlement: Settlement;
  rows: Row[];
  csrf: string;
  error?: string;
  notice?: string;
}

/** One figure, sized by how much it matters. */
function Total(
  props: { label: string; value: string; lead?: boolean; note?: string },
) {
  return (
    <div class="flex flex-col gap-0.5">
      <dt class="text-label-sm text-on-surface-variant">{props.label}</dt>
      <dd
        class={props.lead
          ? "text-headline-lg font-headline text-on-surface"
          : "text-body-lg font-medium text-on-surface"}
      >
        {props.value}
      </dd>
      {props.note && (
        <p class="text-label-sm text-on-surface-variant">{props.note}</p>
      )}
    </div>
  );
}

function SettlementPage(props: SettlementProps) {
  const { game, settlement, rows, csrf } = props;

  return (
    <Page user={props.user} nav="games">
      <div class="flex flex-col gap-6 max-w-3xl mx-auto">
        <a
          href={`/games/${game.slug}`}
          class="text-label font-bold text-on-surface-variant hover:text-primary transition-colors w-fit"
        >
          ← Back to the game
        </a>

        {props.error && <Alert tone="error">{props.error}</Alert>}
        {props.notice && <Alert tone="success">{props.notice}</Alert>}

        <header class="flex flex-col gap-1">
          <h1 class="text-headline-lg font-headline text-on-surface">
            Settlement
          </h1>
          <p class="text-body-md text-on-surface-variant">
            {game.title} · {formatGameTime(game.startUtc, game.endUtc)}
          </p>
        </header>

        {game.confirmedCount === 0
          ? (
            <Alert tone="info">
              Nobody has joined yet, so there is nothing to collect.
            </Alert>
          )
          : (
            <>
              <Card class="flex flex-col gap-5">
                <dl class="grid grid-cols-2 gap-5">
                  <Total
                    label="Still outstanding"
                    value={formatFils(settlement.outstandingFils)}
                    lead
                    note={settlement.markedCount > 0
                      ? `Includes ${settlement.markedCount} claimed but not confirmed.`
                      : undefined}
                  />
                  <Total
                    label="Collected"
                    value={formatFils(settlement.collectedFils)}
                    note={`${settlement.paidCount} confirmed`}
                  />
                  <Total
                    label="Total billed"
                    value={formatFils(settlement.owedFils)}
                  />
                  <Total
                    label="Price per player"
                    value={formatFils(game.pricePerPlayerFils)}
                  />
                </dl>

                {settlement.refundedFils > 0 && (
                  <p class="text-label-sm text-on-surface-variant">
                    {formatFils(settlement.refundedFils)} refunded across{" "}
                    {settlement.refundedCount}{" "}
                    {settlement.refundedCount === 1 ? "player" : "players"}, and
                    counted in neither figure above.
                  </p>
                )}
              </Card>

              <Card class="flex flex-col gap-3">
                <h2 class="text-body-lg font-bold text-on-surface">
                  Confirmed roster
                </h2>
                <ul class="flex flex-col divide-y divide-outline-variant">
                  {rows.map((row) => (
                    <PlayerRow
                      key={row.signup.userId}
                      row={row}
                      game={game}
                      slug={game.slug}
                      csrf={csrf}
                    />
                  ))}
                </ul>
                {rows.length === 0 && (
                  <p class="text-body-md text-on-surface-variant py-4 text-center">
                    Nobody is on the confirmed roster.
                  </p>
                )}
              </Card>
            </>
          )}
      </div>
    </Page>
  );
}

/**
 * One player's row.
 *
 * Refund is offered only on a confirmed payment, matching `refundPayment`'s
 * rule that only money actually received can be sent back. Offering it on an
 * unpaid row would invite the organizer to assert a transfer that never
 * happened.
 */
function PlayerRow(
  props: { row: Row; game: Game; slug: string; csrf: string },
) {
  const { signup, user } = props.row;
  const name = user?.name ?? "Player";

  return (
    // Two rows on a phone and one on a wider screen. Four things abreast at
    // 390px left the name truncated to three characters while the button took
    // a third of the width — and the name is the part being looked up.
    <li class="flex flex-col sm:flex-row sm:items-center gap-3 py-3">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <Avatar
          name={name}
          userId={signup.userId}
          hasPhoto={user?.hasPhoto}
          size={36}
        />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-body-md text-on-surface truncate">{name}</span>
          <span class="text-label-sm text-on-surface-variant">
            {formatFils(amountOwed(signup, props.game))}
            {signup.guests.length > 0 &&
              ` · ${signup.guests.length} guest${
                signup.guests.length === 1 ? "" : "s"
              }`}
          </span>
        </div>
        <PaymentStateChip payment={signup.payment} />
      </div>

      <div class="flex gap-2 shrink-0">
        {signup.payment !== "paid" && signup.payment !== "refunded" && (
          <form method="post" action={`/games/${props.slug}/payments/confirm`}>
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <input type="hidden" name="userId" value={signup.userId} />
            <Button type="submit" variant="secondary" class="px-4 py-2">
              Mark received
            </Button>
          </form>
        )}
        {signup.payment === "paid" && (
          <form method="post" action={`/games/${props.slug}/payments/refund`}>
            <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
            <input type="hidden" name="userId" value={signup.userId} />
            <Button type="submit" variant="ghost" class="px-4 py-2">
              Refund
            </Button>
          </form>
        )}
      </div>
    </li>
  );
}

export function settlementRoute(app: App<State>) {
  app.get("/g/:groupSlug/organizer/games/:slug/settlement", async (ctx) => {
    const user = requireUser(ctx.state.auth);
    const kv = ctx.state.auth.kv;

    // Guarded against the club in the URL, and then against the game being one
    // of that club's: being an organizer somewhere is not being an organizer
    // here, and a game slug from another club is not this club's to settle.
    const access = assertOrganizer(
      await resolveGroupAccess(ctx.state.auth, ctx.params.groupSlug!),
    );

    const game = await getGameBySlug(kv, ctx.params.slug!);
    if (!game || game.groupId !== access.group.id) {
      throw new HttpError(404, "That game could not be found");
    }

    const [settlement, confirmed] = await Promise.all([
      settlementFor(kv, game.id),
      listRoster(kv, game.id, "confirmed"),
    ]);

    const rows: Row[] = await Promise.all(
      confirmed.map(async (signup) => ({
        signup,
        user: await getUser(kv, signup.userId),
      })),
    );

    const url = new URL(ctx.req.url);
    const response = await ctx.render(
      <SettlementPage
        user={user}
        game={game}
        settlement={settlement}
        rows={rows}
        csrf={ctx.state.auth.csrfToken}
        error={url.searchParams.get("error") ?? undefined}
        notice={url.searchParams.get("notice") ?? undefined}
      />,
    );
    response.headers.append(
      "set-cookie",
      csrfCookie(ctx.state.auth.csrfToken, isSecureRequest(ctx.req)),
    );
    return response;
  });
}
