// The part of the vendored QR encoder (qrcode.js, kept as it came) that
// totp.ts uses.
export interface QRCode {
  addData(data: string, mode?: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}

// typeNumber 0 picks the smallest version the data fits in.
export declare const qrcode: (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QRCode;
