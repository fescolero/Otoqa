"use client";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { InvoiceTemplate } from "./preview/invoice-template";
import { InvoicePDFTemplate } from "./preview/invoice-pdf-template";
import { Download, Printer, ExternalLink, Loader2, X, ChevronLeft, ChevronRight } from "lucide-react";
import { pdf } from "@react-pdf/renderer";
import Link from "next/link";
import { toast } from "sonner";

interface InvoicePreviewSheetProps {
  invoiceId: Id<"loadInvoices"> | null;
  isOpen: boolean;
  onClose: () => void;
  allInvoiceIds?: Id<"loadInvoices">[];
  onNavigate?: (invoiceId: Id<"loadInvoices">) => void;
}

export function InvoicePreviewSheet({ invoiceId, isOpen, onClose, allInvoiceIds = [], onNavigate }: InvoicePreviewSheetProps) {
  // Calculate current position and navigation availability
  const currentIndex = invoiceId ? allInvoiceIds.findIndex(id => id === invoiceId) : -1;
  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < allInvoiceIds.length - 1;
  
  const handlePrevious = () => {
    if (hasPrevious && onNavigate) {
      onNavigate(allInvoiceIds[currentIndex - 1]);
    }
  };
  
  const handleNext = () => {
    if (hasNext && onNavigate) {
      onNavigate(allInvoiceIds[currentIndex + 1]);
    }
  };
  
  // Keyboard shortcuts for navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && hasPrevious) {
      e.preventDefault();
      handlePrevious();
    } else if (e.key === 'ArrowRight' && hasNext) {
      e.preventDefault();
      handleNext();
    }
  };
  // Fetch invoice data with calculated amounts
  const invoice = useQuery(
    api.invoices.getInvoice, 
    invoiceId ? { invoiceId } : "skip"
  );
  
  // Fetch line items
  const lineItems = useQuery(
    api.invoices.getLineItems, 
    invoiceId ? { invoiceId } : "skip"
  );
  
  // Fetch customer
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

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent 
        className="w-full sm:max-w-3xl p-0 print:max-w-full print:border-0 print:shadow-none"
        onKeyDown={handleKeyDown}
      >
        <div className="h-full flex flex-col">
          {/* Toolbar */}
          <div className="h-14 border-b bg-background flex items-center justify-between px-6 shrink-0 print:hidden">
            <div className="flex items-center gap-3">
              <SheetTitle className="text-sm font-medium">
                Invoice Preview
                {invoice?.invoiceNumber && (
                  <span className="text-muted-foreground ml-2 font-mono">
                    {invoice.invoiceNumber}
                  </span>
                )}
              </SheetTitle>
              
              {/* Navigation arrows */}
              {allInvoiceIds.length > 1 && (
                <div className="flex items-center gap-1 ml-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handlePrevious}
                    disabled={!hasPrevious}
                    className="h-8 w-8 p-0"
                    title="Previous invoice (←)"
                  >
                    <ChevronLeft className="h-4 w-4" strokeWidth={2} />
                  </Button>
                  <span className="text-xs text-muted-foreground px-2">
                    {currentIndex + 1} / {allInvoiceIds.length}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleNext}
                    disabled={!hasNext}
                    className="h-8 w-8 p-0"
                    title="Next invoice (→)"
                  >
                    <ChevronRight className="h-4 w-4" strokeWidth={2} />
                  </Button>
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-2">
              {invoiceId && (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/invoices/${invoiceId}/preview`} target="_blank">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Full Page
                  </Link>
                </Button>
              )}
              
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handlePrint}
                disabled={!invoice}
              >
                <Printer className="w-4 h-4 mr-2" />
                Print
              </Button>
              
              <Button 
                size="sm"
                onClick={handleDownloadPDF}
                disabled={!invoice}
              >
                <Download className="w-4 h-4 mr-2" />
                PDF
              </Button>
              
              <Button 
                variant="ghost" 
                size="icon"
                onClick={onClose}
                className="h-8 w-8 ml-2"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden relative print:overflow-visible print:h-auto">
            {!invoice || !customer || !lineItems ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Loading invoice preview...</p>
                </div>
              </div>
            ) : (
              <InvoiceTemplate 
                invoice={invoice}
                customer={customer}
                lineItems={lineItems as any}
                companyDetails={companyDetails}
              />
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
