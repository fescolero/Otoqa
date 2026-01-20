'use client';

import { useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Download, QrCode, Printer } from 'lucide-react';
import { Id } from '@/convex/_generated/dataModel';

interface TruckQRCodeProps {
  truckId: Id<'trucks'>;
  unitId: string;
  make?: string;
  model?: string;
  year?: number;
}

/**
 * QR Code data format for truck identification
 * Mobile app parses this to switch driver's assigned truck
 */
interface QRCodeData {
  type: 'otoqa-truck';
  truckId: string;
  unitId: string;
}

export function TruckQRCode({ truckId, unitId, make, model, year }: TruckQRCodeProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  // Create QR code data payload
  const qrData: QRCodeData = {
    type: 'otoqa-truck',
    truckId: truckId,
    unitId: unitId,
  };

  const qrValue = JSON.stringify(qrData);

  // Download QR code as PNG
  const handleDownload = useCallback(() => {
    if (!qrRef.current) return;

    const svg = qrRef.current.querySelector('svg');
    if (!svg) return;

    // Create canvas from SVG
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Set canvas size (larger for better print quality)
    const size = 400;
    const padding = 40;
    const totalSize = size + padding * 2;
    canvas.width = totalSize;
    canvas.height = totalSize + 80; // Extra space for label

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Convert SVG to image
    const svgData = new XMLSerializer().serializeToString(svg);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const img = new Image();
    img.onload = () => {
      // Draw QR code centered with padding
      ctx.drawImage(img, padding, padding, size, size);

      // Add truck unit ID label below QR code
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(unitId, canvas.width / 2, size + padding + 50);

      // Trigger download
      const link = document.createElement('a');
      link.download = `truck-qr-${unitId}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();

      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [unitId]);

  // Print QR code
  const handlePrint = useCallback(() => {
    if (!qrRef.current) return;

    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const svg = qrRef.current.querySelector('svg');
    if (!svg) return;

    const svgData = new XMLSerializer().serializeToString(svg);
    const vehicleInfo = [year, make, model].filter(Boolean).join(' ');

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>QR Code - ${unitId}</title>
          <style>
            body {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              padding: 20px;
              font-family: system-ui, -apple-system, sans-serif;
              box-sizing: border-box;
            }
            .qr-container {
              text-align: center;
              padding: 30px;
              border: 2px dashed #ccc;
              border-radius: 12px;
            }
            .qr-code {
              width: 200px;
              height: 200px;
            }
            .unit-id {
              font-size: 28px;
              font-weight: bold;
              margin-top: 16px;
              color: #000;
            }
            .vehicle-info {
              font-size: 14px;
              color: #666;
              margin-top: 8px;
            }
            .instructions {
              font-size: 12px;
              color: #888;
              margin-top: 16px;
              max-width: 200px;
            }
            @media print {
              .qr-container {
                border: 1px solid #000;
              }
            }
          </style>
        </head>
        <body>
          <div class="qr-container">
            <div class="qr-code">${svgData}</div>
            <div class="unit-id">${unitId}</div>
            ${vehicleInfo ? `<div class="vehicle-info">${vehicleInfo}</div>` : ''}
            <div class="instructions">Scan with Otoqa Driver app to switch to this truck</div>
          </div>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.print();
  }, [unitId, make, model, year]);

  const vehicleInfo = [year, make, model].filter(Boolean).join(' ');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <QrCode className="h-5 w-5 text-muted-foreground" />
          <CardTitle>Vehicle QR Code</CardTitle>
        </div>
        <CardDescription>
          Scan with the driver app to switch trucks
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* QR Code Display */}
        <div 
          ref={qrRef}
          className="flex flex-col items-center justify-center p-4 bg-white rounded-lg border"
        >
          <QRCodeSVG
            value={qrValue}
            size={160}
            level="H" // High error correction for durability
            includeMargin={true}
          />
          <p className="mt-2 text-base font-bold text-gray-900">{unitId}</p>
          {vehicleInfo && (
            <p className="text-xs text-gray-500">{vehicleInfo}</p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleDownload}
          >
            <Download className="mr-2 h-4 w-4" />
            Download
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handlePrint}
          >
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
        </div>

        {/* Placement Instructions */}
        <p className="text-xs text-muted-foreground">
          Print and attach to the truck dashboard or door frame for easy driver scanning.
        </p>
      </CardContent>
    </Card>
  );
}
