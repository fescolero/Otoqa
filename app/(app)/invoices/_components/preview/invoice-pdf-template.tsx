import React from 'react';
import { Document, Page, Text, View, StyleSheet, Image } from '@react-pdf/renderer';

// Register fonts (optional - can use defaults)
// Font.register({
//   family: 'Inter',
//   src: 'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2',
// });

const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  logo: {
    width: 40,
    height: 40,
    backgroundColor: '#6366f1',
    color: '#ffffff',
    textAlign: 'center',
    paddingTop: 12,
    fontSize: 18,
    fontWeight: 'bold',
  },
  logoImage: {
    width: 40,
    height: 40,
    objectFit: 'contain',
  },
  companyInfo: {
    fontSize: 9,
    color: '#666666',
    lineHeight: 1.4,
  },
  invoiceTitle: {
    fontSize: 24,
    textAlign: 'right',
    marginBottom: 8,
  },
  statusBadge: {
    fontSize: 9,
    padding: '4 8',
    borderRadius: 4,
    textAlign: 'right',
  },
  statusDraft: {
    backgroundColor: '#f1f5f9',
    color: '#64748b',
  },
  statusPaid: {
    backgroundColor: '#dcfce7',
    color: '#166534',
  },
  metaSection: {
    flexDirection: 'row',
    gap: 40,
    marginBottom: 20,
    fontSize: 9,
  },
  metaLabel: {
    color: '#666666',
    marginBottom: 2,
  },
  metaValue: {
    fontWeight: 'bold',
    fontFamily: 'Courier',
  },
  addressSection: {
    flexDirection: 'row',
    gap: 40,
    marginBottom: 20,
  },
  addressBlock: {
    flex: 1,
  },
  addressLabel: {
    fontSize: 8,
    color: '#666666',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  addressText: {
    fontSize: 9,
    lineHeight: 1.4,
  },
  table: {
    marginBottom: 20,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#f8fafc',
    padding: 8,
    fontSize: 8,
    fontWeight: 'bold',
    color: '#64748b',
    textTransform: 'uppercase',
    borderBottom: '1 solid #e2e8f0',
  },
  tableRow: {
    flexDirection: 'row',
    padding: 8,
    borderBottom: '1 solid #f1f5f9',
  },
  colDescription: {
    flex: 2,
  },
  colRate: {
    flex: 0.5,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  colQty: {
    flex: 0.3,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  colAmount: {
    flex: 0.5,
    textAlign: 'right',
    fontFamily: 'Courier',
  },
  badge: {
    fontSize: 7,
    padding: '2 6',
    borderRadius: 3,
    marginTop: 4,
  },
  badgeFreight: {
    backgroundColor: '#dbeafe',
    color: '#1e40af',
  },
  badgeFuel: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
  },
  badgeAccessorial: {
    backgroundColor: '#f3e8ff',
    color: '#6b21a8',
  },
  summarySection: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 20,
  },
  summaryBox: {
    width: 200,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: '6 12',
    fontSize: 9,
  },
  summaryTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: '8 12',
    fontSize: 11,
    fontWeight: 'bold',
    backgroundColor: '#f8fafc',
    borderTop: '2 solid #e2e8f0',
  },
  footerSection: {
    flexDirection: 'row',
    gap: 40,
    marginTop: 20,
    paddingTop: 20,
    borderTop: '1 dashed #e2e8f0',
  },
  footerBlock: {
    flex: 1,
  },
  footerLabel: {
    fontSize: 8,
    color: '#666666',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  footerText: {
    fontSize: 9,
    lineHeight: 1.5,
    color: '#333333',
  },
  footerNote: {
    fontSize: 8,
    color: '#999999',
    marginTop: 8,
  },
  pageFooter: {
    position: 'absolute',
    bottom: 30,
    left: 40,
    right: 40,
    textAlign: 'center',
    fontSize: 8,
    color: '#999999',
    paddingTop: 12,
    borderTop: '1 solid #e2e8f0',
  },
});

interface InvoiceLineItem {
  _id: string;
  description: string;
  type: 'FREIGHT' | 'FUEL' | 'ACCESSORIAL' | 'TAX';
  rate: number;
  quantity: number;
  amount: number;
}

interface Customer {
  _id: string;
  name: string;
  companyName?: string;
  officeLocation?: {
    address: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
  };
}

interface Invoice {
  _id: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  status: 'MISSING_DATA' | 'DRAFT' | 'BILLED' | 'PENDING_PAYMENT' | 'PAID' | 'VOID';
  currency: 'USD' | 'CAD' | 'MXN';
  subtotal: number;
  fuelSurcharge?: number;
  accessorialsTotal?: number;
  taxAmount?: number;
  totalAmount: number;
}

interface CompanyDetails {
  name: string;
  address: string;
  email: string;
  phone?: string;
  logoUrl?: string;
}

interface InvoicePDFTemplateProps {
  invoice: Invoice;
  customer: Customer;
  lineItems: InvoiceLineItem[];
  companyDetails: CompanyDetails;
}

const formatCurrency = (amount: number, currency: string = 'USD') => {
  const symbol = currency === 'USD' ? '$' : currency === 'CAD' ? 'C$' : 'MX$';
  return `${symbol}${amount.toFixed(2)}`;
};

const formatDate = (dateString?: string) => {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
};

const getBadgeStyle = (type: string) => {
  switch (type) {
    case 'FREIGHT':
      return styles.badgeFreight;
    case 'FUEL':
      return styles.badgeFuel;
    case 'ACCESSORIAL':
      return styles.badgeAccessorial;
    default:
      return styles.badgeFreight;
  }
};

const getStatusStyle = (status: string) => {
  if (status === 'PAID') return styles.statusPaid;
  return styles.statusDraft;
};

export const InvoicePDFTemplate: React.FC<InvoicePDFTemplateProps> = ({
  invoice,
  customer,
  lineItems,
  companyDetails,
}) => {
  const customerAddress = customer.officeLocation
    ? `${customer.officeLocation.address}\n${customer.officeLocation.city}, ${customer.officeLocation.state} ${customer.officeLocation.zip}\n${customer.officeLocation.country || 'United States'}`
    : 'Address not available';

  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            {companyDetails.logoUrl ? (
              <Image src={companyDetails.logoUrl} style={styles.logoImage} />
            ) : (
              <View style={styles.logo}>
                <Text>{companyDetails.name.substring(0, 1)}</Text>
              </View>
            )}
            <Text style={{ fontWeight: 'bold', fontSize: 12, marginTop: 8 }}>
              {companyDetails.name}
            </Text>
            <Text style={styles.companyInfo}>{companyDetails.address}</Text>
            <Text style={styles.companyInfo}>{companyDetails.email}</Text>
            {companyDetails.phone && (
              <Text style={styles.companyInfo}>{companyDetails.phone}</Text>
            )}
          </View>

          <View>
            <Text style={styles.invoiceTitle}>INVOICE</Text>
            <View style={[styles.statusBadge, getStatusStyle(invoice.status)]}>
              <Text>{invoice.status.replace('_', ' ')}</Text>
            </View>
          </View>
        </View>

        {/* Meta Information */}
        <View style={styles.metaSection}>
          <View>
            <Text style={styles.metaLabel}>Invoice No:</Text>
            <Text style={styles.metaValue}>{invoice.invoiceNumber || 'DRAFT'}</Text>
          </View>
          <View>
            <Text style={styles.metaLabel}>Issued:</Text>
            <Text style={styles.metaValue}>{formatDate(invoice.invoiceDate)}</Text>
          </View>
          <View>
            <Text style={styles.metaLabel}>Due Date:</Text>
            <Text style={styles.metaValue}>{formatDate(invoice.dueDate)}</Text>
          </View>
        </View>

        {/* Addresses */}
        <View style={styles.addressSection}>
          <View style={styles.addressBlock}>
            <Text style={styles.addressLabel}>FROM</Text>
            <Text style={[styles.addressText, { fontWeight: 'bold' }]}>
              {companyDetails.name}
            </Text>
            <Text style={styles.addressText}>{companyDetails.email}</Text>
            {companyDetails.phone && (
              <Text style={styles.addressText}>{companyDetails.phone}</Text>
            )}
            <Text style={styles.addressText}>{companyDetails.address}</Text>
          </View>

          <View style={styles.addressBlock}>
            <Text style={styles.addressLabel}>BILL TO</Text>
            <Text style={[styles.addressText, { fontWeight: 'bold' }]}>
              {customer.companyName || customer.name}
            </Text>
            <Text style={styles.addressText}>{customerAddress}</Text>
          </View>
        </View>

        {/* Line Items Table */}
        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.colDescription}>DESCRIPTION</Text>
            <Text style={styles.colRate}>RATE</Text>
            <Text style={styles.colQty}>QTY</Text>
            <Text style={styles.colAmount}>AMOUNT</Text>
          </View>

          {lineItems.map((item) => (
            <View key={item._id} style={styles.tableRow}>
              <View style={styles.colDescription}>
                <Text>{item.description}</Text>
                <View style={[styles.badge, getBadgeStyle(item.type)]}>
                  <Text>{item.type.toLowerCase()}</Text>
                </View>
              </View>
              <Text style={styles.colRate}>
                {formatCurrency(item.rate, invoice.currency)}
              </Text>
              <Text style={styles.colQty}>{item.quantity}</Text>
              <Text style={styles.colAmount}>
                {formatCurrency(item.amount, invoice.currency)}
              </Text>
            </View>
          ))}
        </View>

        {/* Summary */}
        <View style={styles.summarySection}>
          <View style={styles.summaryBox}>
            <View style={styles.summaryRow}>
              <Text>Subtotal</Text>
              <Text>{formatCurrency(invoice.subtotal, invoice.currency)}</Text>
            </View>
            {!!invoice.fuelSurcharge && (
              <View style={styles.summaryRow}>
                <Text>Fuel Surcharge</Text>
                <Text>{formatCurrency(invoice.fuelSurcharge, invoice.currency)}</Text>
              </View>
            )}
            {!!invoice.accessorialsTotal && (
              <View style={styles.summaryRow}>
                <Text>Accessorials</Text>
                <Text>{formatCurrency(invoice.accessorialsTotal, invoice.currency)}</Text>
              </View>
            )}
            {!!invoice.taxAmount && (
              <View style={styles.summaryRow}>
                <Text>Tax</Text>
                <Text>{formatCurrency(invoice.taxAmount, invoice.currency)}</Text>
              </View>
            )}
            <View style={styles.summaryTotal}>
              <Text>Total Due</Text>
              <Text>{formatCurrency(invoice.totalAmount, invoice.currency)}</Text>
            </View>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footerSection}>
          <View style={styles.footerBlock}>
            <Text style={styles.footerLabel}>PAYMENT DETAILS</Text>
            <Text style={styles.footerText}>Bank: Chase JP Morgan</Text>
            <Text style={styles.footerText}>Account: **** 4029</Text>
            <Text style={styles.footerText}>Routing: 021000021</Text>
            <Text style={styles.footerNote}>Payment due within 30 days of invoice date</Text>
          </View>

          <View style={styles.footerBlock}>
            <Text style={styles.footerLabel}>NOTES</Text>
            <Text style={styles.footerText}>
              Thank you for your business. For questions regarding this invoice, please
              contact {companyDetails.email}.
            </Text>
          </View>
        </View>

        {/* Page Footer */}
        <View style={styles.pageFooter}>
          <Text>
            {companyDetails.name} • Generated on {new Date().toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric'
            })}
          </Text>
        </View>
      </Page>
    </Document>
  );
};
