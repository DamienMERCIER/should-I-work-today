/**
 * A Telegram name is free-form: line breaks, control characters and bidi overrides in it would
 * fake up a line like "⚙️ … joined the bot" in a message to the admin, or would throw off the friends
 * list. HTML, for its part, is escaped at display time.
 */
export const oneLine = (s = ''): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
