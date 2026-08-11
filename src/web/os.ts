/** 운영체제 — 브라우저가 아는 만큼만 */
export const platform = () => (navigator.userAgent.includes('Win') ? 'windows'
  : navigator.userAgent.includes('Mac') ? 'macos' : 'linux');
export const type = platform;
export const version = () => '';
export const arch = () => 'x86_64';
