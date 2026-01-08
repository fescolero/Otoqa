"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { InvoiceTemplate } from "@/app/invoices/_components/preview/invoice-template";
import { InvoicePDFTemplate } from "@/app/invoices/_components/preview/invoice-pdf-template";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Printer, Download } from "lucide-react";
import { pdf } from "@react-pdf/renderer";
import { toast } from "sonner";
import Link from "next/link";
import { useEffect } from "react";

export default function InvoicePreviewPage() {
  const params = useParams();
  const invoiceId = params.invoiceId as Id<"loadInvoices">;

  // Fetch invoice data with calculated amounts
  const invoice = useQuery(api.invoices.getInvoice, { invoiceId });
  const lineItems = useQuery(api.invoices.getLineItems, { invoiceId });
  
  // Debug: Log invoice data
  useEffect(() => {
    if (invoice) {
      console.log('Invoice data:', invoice);
      console.log('Subtotal:', invoice.subtotal);
      console.log('Total:', invoice.totalAmount);
    }
  }, [invoice]);
  const customer = useQuery(
    api.customers.getById, 
    invoice?.customerId ? { customerId: invoice.customerId } : "skip"
  );

  // Format phone number for display: (760)755-3340
  const formatPhoneNumber = (phone: string): string => {
    if (!phone) return "";
    const digits = phone.replace(/\D/g, '');
    if (digits.length !== 10) return phone; // Return as-is if not 10 digits
    return `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`;
  };

  // Fetch organization settings for company details
  const orgSettings = useQuery(
    api.settings.getOrgSettings,
    invoice?.workosOrgId ? { workosOrgId: invoice.workosOrgId } : "skip"
  );

  // Build company details from org settings or use defaults
  const companyDetails = orgSettings
    ? {
        name: orgSettings.name || "Company Name",
        email: orgSettings.billingEmail || "billing@company.com",
        phone: formatPhoneNumber(orgSettings.billingPhone || ""),
        address: orgSettings.billingAddress
          ? `${orgSettings.billingAddress.addressLine1}${orgSettings.billingAddress.addressLine2 ? '\n' + orgSettings.billingAddress.addressLine2 : ''}\n${orgSettings.billingAddress.city}, ${orgSettings.billingAddress.state} ${orgSettings.billingAddress.zip}\n${orgSettings.billingAddress.country}`
          : "Address not available",
        logoUrl: orgSettings.logoUrl || undefined,
      }
    : {
        name: "Company Name",
        email: "billing@company.com",
        phone: "",
        address: "Address not available",
        logoUrl: undefined,
      };

  const handlePrint = async () => {
    if (!invoice || !customer || !lineItems) {
      toast.error("Invoice data not ready");
      return;
    }

    try {
      toast.loading("Generating PDF for printing...");
      
      const blob = await pdf(
        <InvoicePDFTemplate
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
        />
      ).toBlob();
      
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      
      toast.dismiss();
      toast.success("PDF opened in new tab");
      
      // Clean up the URL after a delay
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast.dismiss();
      toast.error("Failed to generate PDF");
      console.error('PDF generation error:', error);
    }
  };

  const handleDownloadPDF = async () => {
    if (!invoice || !customer || !lineItems) {
      toast.error("Invoice data not ready");
      return;
    }

    try {
      toast.loading("Generating PDF...");
      
      const blob = await pdf(
        <InvoicePDFTemplate
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
        />
      ).toBlob();
      
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `invoice-${invoice.invoiceNumber || 'draft'}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      toast.dismiss();
      toast.success("PDF downloaded successfully");
    } catch (error) {
      toast.dismiss();
      toast.error("Failed to generate PDF");
      console.error('PDF generation error:', error);
    }
  };

  if (!invoice || !customer || !lineItems) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-sm text-muted-foreground">Loading invoice...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      {/* Action Bar (hidden when printing) */}
      <div className="print:hidden bg-background border-b sticky top-0 z-50">
        <div className="max-w-[800px] mx-auto px-4 py-3 flex items-center justify-between">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/invoices">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Invoices
            </Link>
          </Button>
          
          <div className="flex items-center gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handlePrint}
            >
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
            
            <Button 
              size="sm"
              onClick={handleDownloadPDF}
            >
              <Download className="w-4 h-4 mr-2" />
              Save as PDF
            </Button>
          </div>
        </div>
      </div>

      {/* Print Instructions (hidden when printing) */}
      <div className="print:hidden max-w-[800px] mx-auto px-4 py-4">
        <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-3 text-center">
          <p className="text-sm text-blue-900 dark:text-blue-100">
            💡 <strong>Tip:</strong> Press <kbd className="px-2 py-1 bg-white dark:bg-slate-800 border rounded text-xs font-mono">Cmd+P</kbd> (Mac) 
            or <kbd className="px-2 py-1 bg-white dark:bg-slate-800 border rounded text-xs font-mono">Ctrl+P</kbd> (Windows) 
            to save as PDF
          </p>
        </div>
      </div>

      {/* Invoice Content */}
      <div className="print:p-0 print:bg-white">
        <InvoiceTemplate 
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
        />
      </div>
    </div>
  );
}
