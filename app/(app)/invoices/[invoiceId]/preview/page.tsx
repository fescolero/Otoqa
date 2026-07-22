"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { InvoiceTemplate } from "@/app/(app)/invoices/_components/preview/invoice-template";
import { RecordPaymentDialog } from "@/app/(app)/invoices/_components/record-payment-dialog";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Printer, Download, DollarSign, Receipt } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

export default function InvoicePreviewPage() {
  const params = useParams();
  const invoiceId = params.invoiceId as Id<"loadInvoices">;

  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);

  // Fetch invoice data with calculated amounts
  const invoice = useQuery(api.invoices.getInvoice, { invoiceId });
  const lineItems = useQuery(api.invoices.getLineItems, { invoiceId });
  const payments = useQuery(api.invoices.listInvoicePayments, { invoiceId });

  const customer = useQuery(
    api.customers.getById,
    invoice?.customerId ? { customerId: invoice.customerId } : "skip"
  );

  const bulkMarkBilled = useMutation(api.invoices.bulkMarkBilled);

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

      const { pdf } = await import("@react-pdf/renderer");
      const { InvoicePDFTemplate } = await import("@/app/(app)/invoices/_components/preview/invoice-pdf-template");
      const blob = await pdf(
        <InvoicePDFTemplate
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
          payments={payments ?? undefined}
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

      const { pdf } = await import("@react-pdf/renderer");
      const { InvoicePDFTemplate } = await import("@/app/(app)/invoices/_components/preview/invoice-pdf-template");
      const blob = await pdf(
        <InvoicePDFTemplate
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
          payments={payments ?? undefined}
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

  const handleMarkBilled = async () => {
    if (!invoice || !userId) return;
    try {
      toast.loading("Marking as billed...");
      await bulkMarkBilled({ invoiceIds: [invoiceId], workosOrgId: invoice.workosOrgId, updatedBy: userId });
      toast.dismiss();
      toast.success("Invoice marked as billed");
    } catch (error) {
      toast.dismiss();
      toast.error("Failed to mark as billed");
      console.error('Mark billed error:', error);
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

  const isDraft = invoice.status === 'DRAFT';
  const isOpen = invoice.status === 'BILLED' || invoice.status === 'PENDING_PAYMENT';

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-slate-100 dark:bg-slate-950 print:h-auto print:overflow-visible">
      {/* Action Bar (hidden when printing) */}
      <div className="print:hidden bg-background border-b sticky top-0 z-50">
        <div className="max-w-[800px] mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Button variant="ghost" size="sm" asChild className="shrink-0">
            <Link href="/invoices">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Invoices
            </Link>
          </Button>

          <div className="flex items-center gap-2 shrink-0">
            {isDraft && userId && (
              <Button size="sm" onClick={handleMarkBilled}>
                <Receipt className="w-4 h-4 mr-2" />
                Mark as billed
              </Button>
            )}

            {isOpen && userId && (
              <Button size="sm" onClick={() => setPaymentDialogOpen(true)}>
                <DollarSign className="w-4 h-4 mr-2" />
                Record payment
              </Button>
            )}

            <Button variant="outline" size="sm" onClick={handlePrint}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>

            <Button variant="outline" size="sm" onClick={handleDownloadPDF}>
              <Download className="w-4 h-4 mr-2" />
              Save as PDF
            </Button>
          </div>
        </div>
      </div>

      {/* Invoice Content */}
      <div className="print:p-0 print:bg-white">
        <InvoiceTemplate
          invoice={invoice}
          customer={customer}
          lineItems={lineItems as any}
          companyDetails={companyDetails}
          payments={payments ?? undefined}
        />
      </div>

      {userId && (
        <RecordPaymentDialog
          open={paymentDialogOpen}
          onOpenChange={setPaymentDialogOpen}
          invoiceId={invoiceId}
          workosOrgId={invoice.workosOrgId}
          userId={userId}
          invoiceNumber={invoice.invoiceNumber}
          totalAmount={invoice.totalAmount ?? 0}
          paidAmount={invoice.paidAmount ?? 0}
        />
      )}
    </div>
  );
}
