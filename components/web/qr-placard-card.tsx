/**
 * QRPlacardCard — DSCard-shaped QR card for fleet records.
 *
 * Encodes a typed payload (`{ type: 'otoqa-truck' | 'otoqa-trailer', id,
 * unitId }`) the Otoqa Driver app parses to switch the active vehicle. Adds
 * Download / Print actions so dispatch can produce a physical placard for
 * the cab or trailer door.
 *
 * Replaces the legacy `components/trucks/truck-qr-code.tsx` (shadcn Card
 * version) with one that fits the DetailsFullPage vocabulary.
 */

'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { DSCard, WBtn } from '@/components/web';

interface QRPlacardCardProps {
  kind: 'truck' | 'trailer';
  unit: string;
  /** Convex id string. Encoded as `truckId` for trucks and `trailerId` for
   *  trailers — the exact field names the Otoqa Driver mobile app reads.
   *  Do NOT rename without coordinating with the mobile parser. */
  recordId: string;
  /** Short subtitle on the placard (e.g. "Volvo VNL 760", "53ft Refrigerated"). */
  subtitle?: string;
  /** Section title on the DSCard. Default: "Unit QR code". */
  title?: string;
}

export function QRPlacardCard({
  kind,
  unit,
  recordId,
  subtitle,
  title = 'Unit QR code',
}: QRPlacardCardProps) {
  const qrRef = React.useRef<HTMLDivElement>(null);

  // Payload contract — must stay aligned with the mobile app's parser at
  // `mobile/app/(app)/switch-truck.tsx`:
  //
  //   { type: 'otoqa-truck',    truckId: '…',    unitId: '…' }
  //   { type: 'otoqa-trailer',  trailerId: '…',  unitId: '…' }
  //
  // The parser rejects scans missing `truckId` (or `trailerId`), so don't
  // collapse these into a generic `id` field.
  const payload = JSON.stringify(
    kind === 'truck'
      ? { type: 'otoqa-truck',   truckId:   recordId, unitId: unit }
      : { type: 'otoqa-trailer', trailerId: recordId, unitId: unit },
  );

  const handleDownload = React.useCallback(() => {
    if (!qrRef.current) return;
    const svg = qrRef.current.querySelector('svg');
    if (!svg) return;

    // Placard PNG — mirrors the print HTML's stacked layout:
    //   ┌─────────────────────┐
    //   │   ┌───────────┐     │
    //   │   │  QR code  │     │
    //   │   └───────────┘     │
    //   │                     │
    //   │       <unit>        │
    //   │     <subtitle>      │
    //   │                     │
    //   │  Scan with Otoqa…   │
    //   └─────────────────────┘
    // Drawn at 1000×1300 for crisp output when printed at standard placard
    // sizes (≈4×5"). Browser scales down for on-screen preview.
    const CARD_W = 1000;
    const CARD_H = 1300;
    const PADDING = 80;
    const QR_SIZE = 720;
    const BORDER_W = 4;
    const RADIUS = 28;

    const canvas = document.createElement('canvas');
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // White card background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Rounded outer border (matches the print HTML's dashed→solid card
    // chrome — here we use a thin solid gray since dashed strokes don't
    // export cleanly as PNG at small line widths).
    ctx.strokeStyle = '#d4d4d8';
    ctx.lineWidth = BORDER_W;
    ctx.beginPath();
    const r = RADIUS;
    const x0 = BORDER_W / 2;
    const y0 = BORDER_W / 2;
    const w = CARD_W - BORDER_W;
    const h = CARD_H - BORDER_W;
    // Manual rounded-rect path (supports older browsers + Node-style canvas).
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w - r, y0);
    ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    ctx.lineTo(x0 + w, y0 + h - r);
    ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    ctx.lineTo(x0, y0 + r);
    ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
    ctx.closePath();
    ctx.stroke();

    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      // QR code — centered horizontally near the top
      const qrX = (CARD_W - QR_SIZE) / 2;
      const qrY = PADDING + 20;
      ctx.drawImage(img, qrX, qrY, QR_SIZE, QR_SIZE);

      // Text stack below the QR.
      let cursorY = qrY + QR_SIZE + 110;
      const cx = CARD_W / 2;

      // Unit number — large, black, bold.
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 84px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(unit, cx, cursorY);
      cursorY += 60;

      // Subtitle (vehicle make / model / trailer type).
      if (subtitle) {
        ctx.fillStyle = '#71717a';
        ctx.font = '30px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(subtitle, cx, cursorY);
        cursorY += 70;
      } else {
        cursorY += 30;
      }

      // Instructions — wrap if it doesn't fit one line.
      ctx.fillStyle = '#a1a1aa';
      ctx.font = '26px system-ui, -apple-system, "Segoe UI", sans-serif';
      const instructions = `Scan with Otoqa Driver app to switch to this ${kind}`;
      const maxWidth = CARD_W - PADDING * 2;
      const words = instructions.split(' ');
      const lines: string[] = [];
      let line = '';
      for (const word of words) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth) {
          if (line) lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
      for (const ln of lines) {
        ctx.fillText(ln, cx, cursorY);
        cursorY += 36;
      }

      const link = document.createElement('a');
      link.download = `${kind}-qr-${unit}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [kind, unit, subtitle]);

  const handlePrint = React.useCallback(() => {
    if (!qrRef.current) return;
    const svg = qrRef.current.querySelector('svg');
    if (!svg) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const subline = subtitle ?? '';
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>QR Code · ${unit}</title>
          <style>
            body { display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; font-family: system-ui, -apple-system, sans-serif; }
            .qr-container { text-align: center; padding: 30px; border: 2px dashed #ccc; border-radius: 12px; }
            .qr-code { width: 200px; height: 200px; }
            .unit-id { font-size: 28px; font-weight: bold; margin-top: 16px; color: #000; }
            .vehicle-info { font-size: 14px; color: #666; margin-top: 8px; }
            .instructions { font-size: 12px; color: #888; margin-top: 16px; max-width: 200px; }
            @media print { .qr-container { border: 1px solid #000; } }
          </style>
        </head>
        <body>
          <div class="qr-container">
            <div class="qr-code">${svgData}</div>
            <div class="unit-id">${unit}</div>
            ${subline ? `<div class="vehicle-info">${subline}</div>` : ''}
            <div class="instructions">Scan with Otoqa Driver app to switch to this ${kind}</div>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  }, [kind, unit, subtitle]);

  return (
    <DSCard title={title}>
      <div className="flex flex-col items-center text-center gap-2">
        <div
          ref={qrRef}
          className="rounded-lg bg-white p-2 border border-[var(--border-hairline)]"
        >
          <QRCodeSVG value={payload} size={120} level="H" includeMargin={false} />
        </div>
        <div className="min-w-0">
          <div className="num text-[15px] font-semibold text-foreground tracking-[0.04em]">
            {unit}
          </div>
          {subtitle && (
            <div className="text-[11.5px] text-[var(--text-tertiary)] truncate mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        <p className="m-0 text-[11px] text-[var(--text-tertiary)] leading-[15px] max-w-[220px]">
          Driver scans this at start of shift to switch to this {kind}.
        </p>
        <div className="flex gap-1.5 w-full">
          <WBtn size="sm" leading="download" onClick={handleDownload} full>
            Download
          </WBtn>
          <WBtn size="sm" onClick={handlePrint} full>
            Print
          </WBtn>
        </div>
      </div>
    </DSCard>
  );
}
