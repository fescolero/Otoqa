'use client';

// Settlements ledger adapter (cutover shim).
//
// Reads the per-org `settlements_read_ledger` feature flag and returns a
// NORMALIZED write API plus the flag, so the settlements dashboard + slide-over
// can drive either the legacy (driverSettlements/carrierSettlements) or the new
// (payEngine) ledger behind one interface. READ query refs are swapped inline
// in the components (identical arg shapes); the WRITE mutations differ (the new
// ones use requireCallerIdentity — no userId — and payItem ids / cents-native
// rates), so their arg-mapping is centralized here.
//
// Flag default is legacy → flag-off behavior is byte-identical to before. This
// whole module is deleted once legacy is retired.
import { useMutation } from 'convex/react';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';

const FLAG_KEY = 'settlements_read_ledger';

export type SettlementParty = 'driver' | 'carrier';

type StatusExtra = { paidMethod?: string; paidReference?: string; voidReason?: string; notes?: string };
type LinePatch = {
  rate?: number;
  quantity?: number;
  overrideStartAt?: number;
  overrideEndAt?: number;
  breakMinutes?: number;
  reason?: string;
};

export function useSettlementsLedger(opts: {
  party: SettlementParty;
  organizationId: string;
  userId: string;
}) {
  const { party, organizationId, userId } = opts;

  const flags = useAuthQuery(api.featureFlags.getForOrg, {});
  const useNew = flags?.[FLAG_KEY] === 'new';

  // All refs are created unconditionally (hooks rules).
  const updDriver = useMutation(api.driverSettlements.updateSettlementStatus);
  const updCarrier = useMutation(api.carrierSettlements.updateSettlementStatus);
  const updNew = useMutation(api.payEngine.settlementWrites.updateSettlementStatus);

  const revDriver = useMutation(api.driverSettlements.reversePayment);
  const revCarrier = useMutation(api.carrierSettlements.reversePayment);
  const revNew = useMutation(api.payEngine.settlementWrites.reversePayment);

  const reopenDriver = useMutation(api.driverSettlements.reopenSettlement);
  const reopenCarrier = useMutation(api.carrierSettlements.reopenSettlement);
  const reopenNew = useMutation(api.payEngine.settlementWrites.reopenSettlement);

  const ackDriver = useMutation(api.driverSettlements.acknowledgeBlocker);
  const ackCarrier = useMutation(api.carrierSettlements.acknowledgeBlocker);
  const ackNew = useMutation(api.payEngine.settlementWrites.acknowledgeBlocker);

  const unackDriver = useMutation(api.driverSettlements.unacknowledgeBlocker);
  const unackCarrier = useMutation(api.carrierSettlements.unacknowledgeBlocker);
  const unackNew = useMutation(api.payEngine.settlementWrites.unacknowledgeBlocker);

  const addDriver = useMutation(api.driverSettlements.addManualAdjustment);
  const addCarrier = useMutation(api.carrierSettlements.addManualAdjustment);
  const addNew = useMutation(api.payEngine.settlementWrites.addManualAdjustment);

  const rmDriver = useMutation(api.driverSettlements.removePayableFromSettlement);
  const rmCarrier = useMutation(api.carrierSettlements.removePayableFromSettlement);
  const rmNew = useMutation(api.payEngine.settlementWrites.removePayItem);

  const editDriver = useMutation(api.driverSettlements.editPayableLine);
  const editCarrier = useMutation(api.carrierSettlements.editPayableLine);
  const editNew = useMutation(api.payEngine.editSessionPay.editPayItem);

  const revertDriver = useMutation(api.driverSettlements.revertPayableEdit);
  const revertCarrier = useMutation(api.carrierSettlements.revertPayableEdit);
  const revertNew = useMutation(api.payEngine.editSessionPay.revertPayItemEdit);

  const applyDriver = useMutation(api.driverSettlements.applyRulesAmount);
  const applyCarrier = useMutation(api.carrierSettlements.applyRulesAmount);
  const applyNew = useMutation(api.payEngine.editSessionPay.adoptEnginePayItem);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyId = (id: string) => id as any;

  return {
    useNew,

    async updateStatus(
      settlementId: string,
      newStatus: 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID',
      extra?: StatusExtra,
    ) {
      if (useNew) return updNew({ settlementId: anyId(settlementId), newStatus, ...extra });
      const args = { settlementId: anyId(settlementId), newStatus, userId, ...extra };
      return party === 'driver' ? updDriver(args) : updCarrier(args);
    },

    async reversePayment(settlementId: string) {
      if (useNew) return revNew({ settlementId: anyId(settlementId) });
      return party === 'driver' ? revDriver({ settlementId: anyId(settlementId) }) : revCarrier({ settlementId: anyId(settlementId) });
    },

    /** Reopen an APPROVED settlement to DRAFT for corrections (reason required). */
    async reopen(settlementId: string, reason: string) {
      const a = { settlementId: anyId(settlementId), reason };
      if (useNew) return reopenNew(a);
      return party === 'driver' ? reopenDriver(a) : reopenCarrier(a);
    },

    async ackBlocker(settlementId: string, blockerKey: string, note?: string) {
      if (useNew) return ackNew({ settlementId: anyId(settlementId), blockerKey, note });
      const args = { settlementId: anyId(settlementId), blockerKey, note, userId };
      return party === 'driver' ? ackDriver(args) : ackCarrier(args);
    },

    async unackBlocker(settlementId: string, blockerKey: string) {
      if (useNew) return unackNew({ settlementId: anyId(settlementId), blockerKey });
      return party === 'driver'
        ? unackDriver({ settlementId: anyId(settlementId), blockerKey })
        : unackCarrier({ settlementId: anyId(settlementId), blockerKey });
    },

    async addAdjustment(a: {
      settlementId: string;
      payeeId: string;
      loadId?: string;
      description: string;
      amount: number;
      category?: 'EARNING' | 'REIMBURSEMENT' | 'DEDUCTION';
    }) {
      if (useNew) {
        return addNew({
          settlementId: anyId(a.settlementId),
          description: a.description,
          amount: a.amount,
          loadId: a.loadId ? anyId(a.loadId) : undefined,
          category: a.category,
        });
      }
      const common = {
        settlementId: anyId(a.settlementId),
        loadId: a.loadId ? anyId(a.loadId) : undefined,
        description: a.description,
        amount: a.amount,
        category: a.category,
        workosOrgId: organizationId,
        userId,
      };
      return party === 'driver'
        ? addDriver({ ...common, driverId: anyId(a.payeeId) })
        : addCarrier({ ...common, carrierPartnershipId: anyId(a.payeeId) });
    },

    async removeLine(lineId: string) {
      if (useNew) return rmNew({ payItemId: anyId(lineId) });
      return party === 'driver'
        ? rmDriver({ payableId: anyId(lineId) })
        : rmCarrier({ payableId: anyId(lineId) });
    },

    async editLine(lineId: string, patch: LinePatch) {
      if (useNew) {
        return editNew({
          payItemId: anyId(lineId),
          overrideStartAt: patch.overrideStartAt,
          overrideEndAt: patch.overrideEndAt,
          breakMinutes: patch.breakMinutes,
          quantity: patch.quantity,
          rateMicroCents: patch.rate != null ? BigInt(Math.round(patch.rate * 100_000)) : undefined,
          reason: patch.reason,
        });
      }
      if (party === 'driver') return editDriver({ payableId: anyId(lineId), userId, ...patch });
      // Carrier legacy editPayableLine is rate/quantity only — drop shift fields.
      const { overrideStartAt: _s, overrideEndAt: _e, breakMinutes: _b, ...rest } = patch;
      void _s; void _e; void _b;
      return editCarrier({ payableId: anyId(lineId), userId, ...rest });
    },

    async revertLine(lineId: string) {
      if (useNew) return revertNew({ payItemId: anyId(lineId) });
      return party === 'driver'
        ? revertDriver({ payableId: anyId(lineId) })
        : revertCarrier({ payableId: anyId(lineId) });
    },

    async applyRules(lineId: string) {
      if (useNew) return applyNew({ payItemId: anyId(lineId) });
      return party === 'driver'
        ? applyDriver({ payableId: anyId(lineId) })
        : applyCarrier({ payableId: anyId(lineId) });
    },
  };
}
