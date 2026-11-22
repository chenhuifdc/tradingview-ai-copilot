/**
 * Strict XSS Sanitization & Safe URL Validation Utilities (Zero dependencies).
 */

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

/**
 * Escape untrusted string for safe HTML text/attribute interpolation.
 *
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

/**
 * Validate that an image source URL is strictly a safe `data:image/(png|jpeg|jpg|webp);base64,...` data URL.
 * Rejects `javascript:`, `data:text/html`, `data:image/svg+xml`, external URLs, etc.
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function sanitizeImageDataUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/**
 * Render markdown-like text into escaped HTML with minimal safe formatting (escaping all raw HTML tags first).
 *
 * @param {unknown} mdText
 * @returns {string}
 */
export function renderSafeMarkdown(mdText) {
  const escaped = escapeHtml(mdText);
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
