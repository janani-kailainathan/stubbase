/**
 * The closing call to action a page hands the footer through Layout's `cta`:
 * a heading, a body and a button, with an optional second button and a line of
 * microcopy under them.
 */
export interface FooterCta {
  title: string;
  body: string;
  label: string;
  href: string;
  secondary?: { label: string; href: string };
  note?: string;
}
