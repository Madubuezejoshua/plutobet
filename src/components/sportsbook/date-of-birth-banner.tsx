import Link from "next/link";
import { ShieldAlert } from "lucide-react";

/**
 * Shown on every page while an account has no date of birth on file.
 *
 * NOT DISMISSIBLE. A dismiss control on a compliance prompt is a way to never
 * answer it, and this one blocks betting, deposits and withdrawals until it is
 * answered — hiding it would leave the customer to discover the block at the
 * moment they try to place a bet, with no explanation.
 *
 * It states what is blocked rather than only that something is needed. "We need
 * your date of birth" leaves the customer to find out the hard way; "you cannot
 * bet, deposit or withdraw until you do" is the same sentence with the
 * consequence attached, and it is the one that gets answered.
 *
 * `role="status"` rather than `alert`: it is present on arrival rather than
 * appearing in response to an action, and an assertive live region would
 * interrupt a screen-reader user mid-sentence on every navigation.
 */
export function DateOfBirthBanner() {
  return (
    <div className="sb-banner" role="status">
      <div className="sb-banner__inner">
        <ShieldAlert size={18} aria-hidden="true" className="sb-banner__icon" />
        <p className="sb-banner__text">
          <strong>Confirm your date of birth.</strong> Your account was opened before we recorded
          it, and we are required to check every account holder is 18 or over. You cannot bet,
          deposit or withdraw until this is done.
        </p>
        <Link href="/account/date-of-birth" className="sb-btn sb-btn--primary sb-banner__action">
          Confirm now
        </Link>
      </div>
    </div>
  );
}
