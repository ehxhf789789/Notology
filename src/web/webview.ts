/** 웹뷰 — 브라우저 자신이다 */
import { getCurrentWindow } from './window';
export const getCurrentWebview = () => getCurrentWindow();
export const getCurrentWebviewWindow = () => getCurrentWindow();
export const getAllWebviewWindows = async () => [getCurrentWindow()];
export class WebviewWindow {
  constructor(public label: string) {}
  static getByLabel = async () => null;
}
