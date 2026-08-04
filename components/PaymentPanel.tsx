/**
 * What one player owes for a game, and the single action open to them.
 *
 * Players pay up front, so this renders as soon as someone holds a seat rather
 * than waiting for the cutoff. That is only honest because the price is fixed:
 * there was a period when the figure moved as people joined, and asking for
 * money against a number that could still change would have been asking twice.
 *
 * The figure is the player's own — their seat plus their guests' — never the
 * game's per-seat price, which is not what a player with a +1 owes.
 */

import { Alert, Button, Card, Chip } from "./ui.tsx";
import { amountOwed, formatFils } from "../lib/domain/money.ts";
import type { Game, PayoutDetails, Signup } from "../lib/types.ts";

export interface PaymentPanelProps {
  signup: Signup;
  game: Pick<Game, "pricePerPlayerFils">;
  slug: string;
  csrf: string;
  csrfField: string;
  payout?: PayoutDetails;
}

/**
 * Whether this signup has a bill to show at all.
 *
 * A held seat is not a bill. Someone offered a promotion has not accepted it,
 * and a cancelled signup owes nothing unless the cutoff already forfeited it,
 * which is recorded on the payment state rather than inferred here.
 *
 * Exported so the page can decide whether to render the section without
 * duplicating the rule.
 */
export function hasBill(signup: Signup | null): signup is Signup {
  if (!signup) return false;
  return signup.status === "confirmed" || signup.status === "attended" ||
    signup.payment === "forfeited" || signup.payment === "refunded";
}

/** Where the money goes. Absent until an organizer fills the group in. */
function PayoutDetailsList(props: { payout: PayoutDetails }) {
  const rows: Array<[string, string]> = [
    ["Bank", props.payout.bank],
    ["Account name", props.payout.accountName],
    ["IBAN", props.payout.iban],
  ];

  return (
    <dl class="flex flex-col gap-2 rounded-lg bg-surface-container px-4 py-3">
      {rows.map(([label, value]) => (
        <div key={label} class="flex items-baseline justify-between gap-4">
          <dt class="text-label-sm text-on-surface-variant shrink-0">
            {label}
          </dt>
          <dd class="text-body-md text-on-surface font-medium text-right break-all">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PaymentPanel(props: PaymentPanelProps) {
  const { signup, game, slug, csrf, csrfField, payout } = props;
  const owed = amountOwed(signup, game);

  return (
    <Card accent class="flex flex-col gap-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-0.5">
          <h2 class="text-label-sm text-on-surface-variant">You owe</h2>
          <p class="text-headline-md font-headline text-on-surface">
            {formatFils(owed)}
          </p>
        </div>
        <PaymentStateChip payment={signup.payment} />
      </div>

      {signup.payment === "unpaid" && (
        <>
          {payout ? <PayoutDetailsList payout={payout} /> : (
            <Alert tone="info">
              The organizer has not added bank details yet. Ask them where to
              send it.
            </Alert>
          )}

          <form method="post" action={`/games/${slug}/paid`}>
            <input type="hidden" name={csrfField} value={csrf} />
            <Button type="submit" fullWidth>I have paid</Button>
          </form>
          <p class="text-label-sm text-on-surface-variant">
            Pay before the game. Tapping this tells the organizer you have sent
            it — send them the receipt too if you have one, since they confirm
            it against the account.
          </p>
        </>
      )}

      {signup.payment === "marked_paid" && (
        <p class="text-body-md text-on-surface-variant">
          You marked this paid and the organizer has been told. If it has been a
          while, send them the receipt — they confirm it against the account.
        </p>
      )}

      {signup.payment === "paid" && (
        <p class="text-body-md text-on-surface-variant">
          The organizer confirmed this. Nothing left to do.
        </p>
      )}

      {signup.payment === "refunded" && (
        <p class="text-body-md text-on-surface-variant">
          This was refunded to you.
        </p>
      )}

      {signup.payment === "forfeited" && (
        <p class="text-body-md text-on-surface-variant">
          You left after the cutoff, so your share is still owed.
        </p>
      )}
    </Card>
  );
}

/** The payment state as a chip, used in both the panel and the roster. */
export function PaymentStateChip(props: { payment: Signup["payment"] }) {
  switch (props.payment) {
    case "paid":
      return <Chip tone="success">Paid</Chip>;
    case "marked_paid":
      return <Chip tone="warning">Awaiting confirmation</Chip>;
    case "refunded":
      return <Chip tone="info">Refunded</Chip>;
    case "forfeited":
      return <Chip tone="error">Forfeited</Chip>;
    default:
      return <Chip tone="neutral">Unpaid</Chip>;
  }
}
