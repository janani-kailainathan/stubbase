/**
 * The closing call to action a page hands the footer through Layout's `cta`.
 * `secondary` and `note` are read only by FramedFooter; the default footer
 * shows the heading, body and one button.
 */
export interface FooterCta {
  title: string;
  body: string;
  label: string;
  href: string;
  secondary?: { label: string; href: string };
  note?: string;
}
