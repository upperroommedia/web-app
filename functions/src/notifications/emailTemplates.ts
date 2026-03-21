export interface EmailDetailItem {
  label: string;
  value: string;
}

export interface ProfessionalEmailTemplateInput {
  preheader: string;
  heading: string;
  intro: string;
  details: EmailDetailItem[];
  logoUrl?: string;
  imageUrl?: string;
  imageAlt?: string;
  imageCaption?: string;
  actionLabel?: string;
  actionUrl?: string;
  actionHint?: string;
  footer?: string;
}

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const formatEmailDateTime = (timestampMs: number): string => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  return formatter.format(new Date(timestampMs));
};

export const buildProfessionalEmailHtml = (input: ProfessionalEmailTemplateInput): string => {
  const detailsHtml = input.details
    .map(
      (detail) =>
        `<tr>
          <td style="padding: 8px 0; color: #4b5563; width: 140px; vertical-align: top; font-size: 14px;">${escapeHtml(detail.label)}</td>
          <td style="padding: 8px 0; color: #111827; font-size: 14px; white-space: pre-wrap;">${escapeHtml(detail.value)}</td>
        </tr>`
    )
    .join('');

  const actionHtml =
    input.actionLabel && input.actionUrl
      ? `<div style="margin: 28px 0 18px;">
          <a
            href="${escapeHtml(input.actionUrl)}"
            style="background: #0f172a; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; display: inline-block; font-weight: 600;"
          >
            ${escapeHtml(input.actionLabel)}
          </a>
        </div>`
      : '';

  const actionHintHtml =
    input.actionHint && input.actionUrl
      ? `<p style="margin: 0; color: #6b7280; font-size: 13px;">
          ${escapeHtml(input.actionHint)}
          <br />
          <a href="${escapeHtml(input.actionUrl)}" style="color: #1d4ed8; word-break: break-all;">${escapeHtml(input.actionUrl)}</a>
        </p>`
      : '';

  const imageHtml =
    input.imageUrl
      ? `<div style="margin: 24px 0 8px;">
          <img
            src="${escapeHtml(input.imageUrl)}"
            alt="${escapeHtml(input.imageAlt ?? 'Email image')}"
            style="display: block; max-width: 220px; max-height: 220px; width: 100%; height: auto; border-radius: 12px; border: 1px solid #e5e7eb; background: #f9fafb;"
          />
          ${
            input.imageCaption
              ? `<p style="margin: 10px 0 0; color: #6b7280; font-size: 13px;">${escapeHtml(input.imageCaption)}</p>`
              : ''
          }
        </div>`
      : '';

  const footerText = input.footer ?? 'UpperRoom Media';
  const logoHtml = input.logoUrl
    ? `<img
        src="${escapeHtml(input.logoUrl)}"
        alt="UpperRoom Media"
        width="36"
        height="36"
        style="display: block; width: 36px; height: 36px; border-radius: 8px;"
      />`
    : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background: #f3f4f6;">
    <span style="display: none; opacity: 0; visibility: hidden; overflow: hidden; max-height: 0; max-width: 0;">
      ${escapeHtml(input.preheader)}
    </span>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="padding: 28px 12px;">
      <tr>
        <td align="center">
          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            width="100%"
            style="max-width: 640px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;"
          >
            <tr>
              <td style="padding: 28px 28px 16px;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 8px;">
                  <tr>
                    ${logoHtml ? `<td style="width: 44px; vertical-align: middle;">${logoHtml}</td>` : ''}
                    <td style="vertical-align: middle;">
                      <p style="margin: 0; color: #6b7280; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;">UpperRoom Media</p>
                    </td>
                  </tr>
                </table>
                <h1 style="margin: 0 0 12px; color: #111827; font-size: 24px; line-height: 1.25;">${escapeHtml(input.heading)}</h1>
                <p style="margin: 0; color: #374151; font-size: 15px; line-height: 1.6;">${escapeHtml(input.intro)}</p>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 20px;">
                  ${detailsHtml}
                </table>
                ${imageHtml}
                ${actionHtml}
                ${actionHintHtml}
              </td>
            </tr>
            <tr>
              <td style="padding: 14px 28px 24px; border-top: 1px solid #f3f4f6;">
                <p style="margin: 0; color: #9ca3af; font-size: 12px;">${escapeHtml(footerText)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
};
