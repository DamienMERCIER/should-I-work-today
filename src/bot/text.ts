/**
 * Un nom Telegram est libre : retours à la ligne, caractères de contrôle et inversions bidi y
 * fabriqueraient une fausse ligne « ⚙️ … a rejoint le bot » dans un message à l'admin, ou décaleraient la liste des
 * amis. Le HTML, lui, est échappé à l'affichage.
 */
export const oneLine = (s = ''): string =>
  s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
