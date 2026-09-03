import qrcode from "qrcode-terminal";

export function printQrCode(url: string, label = "扫码打开") {
  process.stdout.write(`\n${label}：\n${url}\n`);
  qrcode.generate(url, { small: true }, (qr) => process.stdout.write(`${qr}\n`));
}
