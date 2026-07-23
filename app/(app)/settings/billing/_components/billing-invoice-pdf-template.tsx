import React from 'react';
import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import {
  INVOICE_BADGE_LABEL,
  INVOICE_TERMS,
  OTOQA_BILLER,
  invoiceBadge,
  invoiceContactNote,
  invoiceMoney as money,
  type BillingInvoiceBillTo,
  type BillingInvoiceContract,
  type BillingInvoiceCycle,
} from './billing-invoice-types';

/**
 * Platform billing-cycle invoice PDF — Otoqa invoicing the org for metered
 * usage (loads written × rate). Visual language mirrors the customer
 * invoice PDF (invoice-pdf-template.tsx) so every PDF the app emits reads
 * as one family. Lazy-import this module (with @react-pdf/renderer) from
 * the preview sheet — never eagerly.
 */

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
    backgroundColor: '#2E5CFF',
    color: '#ffffff',
    textAlign: 'center',
    paddingTop: 12,
    fontSize: 18,
    fontWeight: 'bold',
    borderRadius: 8,
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
  statusDue: {
    backgroundColor: '#fef3c7',
    color: '#92400e',
  },
  statusPaid: {
    backgroundColor: '#dcfce7',
    color: '#166534',
  },
  statusPastDue: {
    backgroundColor: '#fee2e2',
    color: '#b91c1c',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingTop: 3,
    paddingBottom: 3,
    borderBottom: '1 solid #f1f5f9',
    fontSize: 9,
  },
  detailLabel: {
    color: '#666666',
  },
  detailValue: {
    fontWeight: 'bold',
    fontFamily: 'Courier',
    textAlign: 'right',
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
    flex: 0.4,
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
    backgroundColor: '#dbeafe',
    color: '#1e40af',
    alignSelf: 'flex-start',
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

interface BillingInvoicePDFTemplateProps {
  cycle: BillingInvoiceCycle;
  billTo: BillingInvoiceBillTo;
  contract: BillingInvoiceContract;
}

const DetailRow = ({ label, value }: { label: string; value: string }) => (
  <View style={styles.detailRow}>
    <Text style={styles.detailLabel}>{label}</Text>
    <Text style={styles.detailValue}>{value}</Text>
  </View>
);

export const BillingInvoicePDFTemplate: React.FC<BillingInvoicePDFTemplateProps> = ({
  cycle,
  billTo,
  contract,
}) => (
  <Document>
    <Page size="LETTER" style={styles.page}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <View style={styles.logo}>
            <Text>O</Text>
          </View>
          <Text style={{ fontWeight: 'bold', fontSize: 12, marginTop: 8 }}>
            {OTOQA_BILLER.name}
          </Text>
          <Text style={styles.companyInfo}>{OTOQA_BILLER.tagline}</Text>
          <Text style={styles.companyInfo}>{OTOQA_BILLER.email}</Text>
        </View>

        <View>
          <Text style={styles.invoiceTitle}>INVOICE</Text>
          <View
            style={[
              styles.statusBadge,
              invoiceBadge(cycle) === 'paid'
                ? styles.statusPaid
                : invoiceBadge(cycle) === 'pastdue'
                  ? styles.statusPastDue
                  : styles.statusDue,
            ]}
          >
            <Text>{INVOICE_BADGE_LABEL[invoiceBadge(cycle)]}</Text>
          </View>
        </View>
      </View>

      {/* Bill to + invoice details */}
      <View style={styles.addressSection}>
        <View style={styles.addressBlock}>
          <Text style={styles.addressLabel}>BILL TO</Text>
          <Text style={[styles.addressText, { fontWeight: 'bold' }]}>{billTo.companyName}</Text>
          {billTo.addressLines.map((line, i) => (
            <Text key={i} style={styles.addressText}>
              {line}
            </Text>
          ))}
          <Text style={styles.addressText}>{billTo.billingEmail}</Text>
          {billTo.billingPhone ? <Text style={styles.addressText}>{billTo.billingPhone}</Text> : null}
        </View>

        <View style={styles.addressBlock}>
          <Text style={styles.addressLabel}>DETAILS</Text>
          <DetailRow label="Invoice No" value={cycle.invoiceNo} />
          <DetailRow label="Invoice date" value={cycle.issuedOn} />
          <DetailRow label="Due date" value={cycle.dueOn} />
          {cycle.status === 'paid' ? <DetailRow label="Paid" value={cycle.paidOn ?? '—'} /> : null}
          <DetailRow label="Terms" value={INVOICE_TERMS} />
          <DetailRow label="Contract #" value={contract.contractNumber} />
          <DetailRow label="License start" value={contract.licenseStart} />
          <DetailRow label="License end" value={contract.licenseEnd} />
          <DetailRow label="Billing period" value={`${cycle.periodStart} – ${cycle.periodEnd}`} />
        </View>
      </View>

      {/* Line item */}
      <View style={styles.table}>
        <View style={styles.tableHeader}>
          <Text style={styles.colDescription}>DESCRIPTION</Text>
          <Text style={styles.colRate}>RATE</Text>
          <Text style={styles.colQty}>QTY</Text>
          <Text style={styles.colAmount}>AMOUNT</Text>
        </View>

        <View style={styles.tableRow}>
          <View style={styles.colDescription}>
            <Text>
              Platform usage — {cycle.label} ({cycle.periodStart} – {cycle.periodEnd})
            </Text>
            <Text style={{ fontSize: 8, color: '#666666', marginTop: 2 }}>
              Loads written into Otoqa during the billing cycle
            </Text>
            <View style={styles.badge}>
              <Text>metered</Text>
            </View>
          </View>
          <Text style={styles.colRate}>{money(cycle.rate)}</Text>
          <Text style={styles.colQty}>{cycle.loads.toLocaleString('en-US')}</Text>
          <Text style={styles.colAmount}>{money(cycle.amount)}</Text>
        </View>
      </View>

      {/* Summary */}
      <View style={styles.summarySection}>
        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text>Subtotal</Text>
            <Text>{money(cycle.amount)}</Text>
          </View>
          <View style={styles.summaryTotal}>
            <Text>{cycle.status === 'paid' ? 'Total' : 'Total Due'}</Text>
            <Text>{money(cycle.amount)}</Text>
          </View>
        </View>
      </View>

      {/* Footer */}
      <View style={styles.footerSection}>
        <View style={styles.footerBlock}>
          <Text style={styles.footerLabel}>NOTES</Text>
          <Text style={styles.footerText}>{invoiceContactNote()}</Text>
        </View>
      </View>

      {/* Page footer */}
      <View style={styles.pageFooter}>
        <Text>
          {OTOQA_BILLER.name} • {cycle.invoiceNo} • Generated on{' '}
          {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
        </Text>
      </View>
    </Page>
  </Document>
);
