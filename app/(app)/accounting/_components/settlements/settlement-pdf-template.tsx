'use client';

/**
 * SettlementPDF — the @react-pdf/renderer statement document, split out of
 * settlement-doc-panel so that module stays react-pdf-free and the heavy
 * renderer is only pulled in (via dynamic import) when a PDF is actually
 * generated.
 */

import { Document, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import {
  SETTLE_PRESETS,
  PLAN_META,
  chipKeyForRow,
  fmtUSD,
  type SettlementParty,
  type SettlementRow,
} from './settlement-meta';
import {
  fmtDateYear,
  fmtPeriodYear,
  basisLabel,
  lineDisplay,
  type StatementSections,
  type CompanyBlock,
} from './settlement-doc-panel';

const pdfStyles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: 'Helvetica', backgroundColor: '#ffffff' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  companyName: { fontSize: 13, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  muted: { fontSize: 9, color: '#666666', lineHeight: 1.4 },
  docTitle: { fontSize: 22, textAlign: 'right', letterSpacing: 1 },
  docSub: { fontSize: 9, color: '#666666', textAlign: 'right', marginTop: 2 },
  statusText: { fontSize: 9, fontFamily: 'Helvetica-Bold', textAlign: 'right', marginTop: 6 },
  metaRow: {
    flexDirection: 'row',
    gap: 24,
    marginTop: 18,
    paddingTop: 12,
    borderTop: '1 solid #e2e8f0',
  },
  metaBlock: { flex: 1 },
  metaLabel: { fontSize: 7.5, color: '#666666', textTransform: 'uppercase', letterSpacing: 0.5 },
  metaValue: { fontSize: 10, fontFamily: 'Helvetica-Bold', marginTop: 3 },
  partyRow: { flexDirection: 'row', gap: 24, marginTop: 16 },
  partyName: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginTop: 4 },
  tableHead: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 20,
    paddingBottom: 6,
    borderBottom: '1 solid #cbd5e1',
  },
  tableRow: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 7,
    borderBottom: '1 solid #f1f5f9',
  },
  colHead: { fontSize: 7.5, color: '#666666', textTransform: 'uppercase', letterSpacing: 0.5 },
  colMain: { flex: 1 },
  colBasis: { width: 130, textAlign: 'right' },
  colAmount: { width: 80, textAlign: 'right' },
  cellMain: { fontSize: 9.5 },
  cellSub: { fontSize: 8.5, color: '#666666', marginTop: 2 },
  cellNum: { fontSize: 9, color: '#444444' },
  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 16 },
  totalsBox: {
    width: 240,
    border: '1 solid #e2e8f0',
    borderRadius: 6,
    backgroundColor: '#f8fafc',
    padding: 12,
  },
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  totalsDivider: { borderTop: '1 solid #e2e8f0', marginVertical: 4 },
  footer: {
    flexDirection: 'row',
    gap: 24,
    marginTop: 22,
    paddingTop: 12,
    borderTop: '1 dashed #cbd5e1',
  },
  generated: { fontSize: 8.5, color: '#666666', textAlign: 'center', marginTop: 22 },
});

export function SettlementPDF({
  row,
  party,
  sections,
  company,
  generatedOn,
}: {
  row: SettlementRow;
  party: SettlementParty;
  sections: StatementSections;
  company: CompanyBlock;
  generatedOn: string;
}) {
  const chip = SETTLE_PRESETS[chipKeyForRow(row)];
  const planMeta = row.planBasis ? PLAN_META[row.planBasis] : null;
  const hasAdjustments = sections.reimb.length > 0 || sections.deduct.length > 0;

  return (
    <Document>
      <Page size="A4" style={pdfStyles.page}>
        {/* header */}
        <View style={pdfStyles.header}>
          <View>
            <Text style={pdfStyles.companyName}>{company.name}</Text>
            {company.addressLines.map((l) => (
              <Text key={l} style={pdfStyles.muted}>{l}</Text>
            ))}
            {company.email ? <Text style={[pdfStyles.muted, { marginTop: 4 }]}>{company.email}</Text> : null}
            {company.phone ? <Text style={pdfStyles.muted}>{company.phone}</Text> : null}
          </View>
          <View>
            <Text style={pdfStyles.docTitle}>SETTLEMENT</Text>
            <Text style={pdfStyles.docSub}>
              {party === 'carrier' ? 'Carrier statement' : 'Driver statement'}
            </Text>
            <Text style={[pdfStyles.statusText, { color: chip?.fg ?? '#444444' }]}>
              {(chip?.label ?? row.status).toUpperCase()}
            </Text>
          </View>
        </View>

        {/* meta strip */}
        <View style={pdfStyles.metaRow}>
          {(
            [
              ['Statement no.', row.statementNumber],
              ['Pay period', fmtPeriodYear(row.periodStart, row.periodEnd)],
              ['Pay date', fmtDateYear(row.payDate)],
            ] as const
          ).map(([l, v]) => (
            <View key={l} style={pdfStyles.metaBlock}>
              <Text style={pdfStyles.metaLabel}>{l}</Text>
              <Text style={pdfStyles.metaValue}>{v}</Text>
            </View>
          ))}
        </View>

        {/* from / pay to */}
        <View style={pdfStyles.partyRow}>
          <View style={{ flex: 1 }}>
            <Text style={pdfStyles.metaLabel}>From</Text>
            <Text style={pdfStyles.partyName}>{company.name}</Text>
            {company.addressLines.map((l) => (
              <Text key={l} style={pdfStyles.muted}>{l}</Text>
            ))}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={pdfStyles.metaLabel}>Pay to</Text>
            <Text style={pdfStyles.partyName}>{row.payeeName}</Text>
            {row.payeeSub ? <Text style={pdfStyles.muted}>{row.payeeSub}</Text> : null}
            {planMeta ? (
              <Text style={pdfStyles.muted}>{`${planMeta.label}${row.planDetail ? ` — ${row.planDetail}` : ''}`}</Text>
            ) : null}
            {row.cadence ? <Text style={pdfStyles.muted}>Paid {row.cadence.toLowerCase()}</Text> : null}
          </View>
        </View>

        {/* earnings table */}
        <View style={pdfStyles.tableHead}>
          <Text style={[pdfStyles.colHead, pdfStyles.colMain]}>Earnings</Text>
          <Text style={[pdfStyles.colHead, pdfStyles.colBasis]}>Basis</Text>
          <Text style={[pdfStyles.colHead, pdfStyles.colAmount]}>Amount</Text>
        </View>
        {sections.earn.map((p, i) => {
          const d = lineDisplay(p);
          return (
            <View key={`e${i}`} style={pdfStyles.tableRow}>
              <View style={pdfStyles.colMain}>
                <Text style={pdfStyles.cellMain}>{d.label}</Text>
                {d.sub ? <Text style={pdfStyles.cellSub}>{d.sub}</Text> : null}
              </View>
              <Text style={[pdfStyles.cellNum, pdfStyles.colBasis]}>{basisLabel(p, row.planBasis)}</Text>
              <Text style={[pdfStyles.cellMain, pdfStyles.colAmount]}>{fmtUSD(p.totalAmount)}</Text>
            </View>
          );
        })}

        {hasAdjustments && (
          <View style={[pdfStyles.tableHead, { marginTop: 14 }]}>
            <Text style={[pdfStyles.colHead, pdfStyles.colMain]}>Adjustments</Text>
            <Text style={pdfStyles.colBasis} />
            <Text style={pdfStyles.colAmount} />
          </View>
        )}
        {sections.reimb.map((p, i) => (
          <View key={`r${i}`} style={pdfStyles.tableRow}>
            <Text style={[pdfStyles.cellMain, pdfStyles.colMain]}>{p.description}</Text>
            <Text style={[pdfStyles.cellNum, pdfStyles.colBasis]}>Reimbursement</Text>
            <Text style={[pdfStyles.cellMain, pdfStyles.colAmount]}>{fmtUSD(p.totalAmount)}</Text>
          </View>
        ))}
        {sections.deduct.map((p, i) => (
          <View key={`d${i}`} style={pdfStyles.tableRow}>
            <Text style={[pdfStyles.cellMain, pdfStyles.colMain]}>{p.description}</Text>
            <Text style={[pdfStyles.cellNum, pdfStyles.colBasis]}>Deduction</Text>
            <Text style={[pdfStyles.cellMain, pdfStyles.colAmount, { color: '#B43030' }]}>
              -{fmtUSD(Math.abs(p.totalAmount))}
            </Text>
          </View>
        ))}

        {/* totals */}
        <View style={pdfStyles.totalsWrap}>
          <View style={pdfStyles.totalsBox}>
            <View style={pdfStyles.totalsRow}>
              <Text style={pdfStyles.muted}>Earnings</Text>
              <Text style={pdfStyles.cellMain}>{fmtUSD(sections.earnTotal)}</Text>
            </View>
            {sections.reimbTotal > 0 && (
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.muted}>Reimbursements</Text>
                <Text style={pdfStyles.cellMain}>{fmtUSD(sections.reimbTotal)}</Text>
              </View>
            )}
            {sections.deductTotal > 0 && (
              <View style={pdfStyles.totalsRow}>
                <Text style={pdfStyles.muted}>Deductions</Text>
                <Text style={[pdfStyles.cellMain, { color: '#B43030' }]}>
                  -{fmtUSD(sections.deductTotal)}
                </Text>
              </View>
            )}
            <View style={pdfStyles.totalsDivider} />
            <View style={[pdfStyles.totalsRow, { marginBottom: 0 }]}>
              <Text style={{ fontSize: 10.5, fontFamily: 'Helvetica-Bold' }}>Net pay</Text>
              <Text style={{ fontSize: 11.5, fontFamily: 'Helvetica-Bold' }}>{fmtUSD(sections.net)}</Text>
            </View>
            {row.paidAt != null && (
              <Text style={[pdfStyles.muted, { color: '#0F8C5F', marginTop: 6 }]}>
                Paid via {row.paidMethod ?? '—'} on {fmtDateYear(row.paidAt)}
              </Text>
            )}
          </View>
        </View>

        {/* footer */}
        <View style={pdfStyles.footer}>
          <View style={{ flex: 1 }}>
            <Text style={pdfStyles.metaLabel}>Payment method</Text>
            {row.paidAt != null ? (
              <>
                <Text style={[pdfStyles.muted, { marginTop: 5 }]}>
                  Paid on {fmtDateYear(row.paidAt)} via {row.paidMethod ?? '—'}
                </Text>
                {row.paidReference ? (
                  <Text style={pdfStyles.muted}>Reference: {row.paidReference}</Text>
                ) : null}
              </>
            ) : (
              <Text style={[pdfStyles.muted, { marginTop: 5 }]}>
                Scheduled for {fmtDateYear(row.payDate)}
              </Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={pdfStyles.metaLabel}>Notes</Text>
            <Text style={[pdfStyles.muted, { marginTop: 5 }]}>
              {row.notes ??
                `Questions about this statement? Contact ${company.email || 'your administrator'} within 30 days of the pay date.`}
            </Text>
          </View>
        </View>

        <Text style={pdfStyles.generated}>
          {company.name ? `${company.name} · ` : ''}Generated on {generatedOn}
        </Text>
      </Page>
    </Document>
  );
}
