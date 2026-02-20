export type ExtractionConfig = {
  includeLogistics: boolean;
  includeFinancial: boolean;
  extractDates: boolean;
  stopDetailLevel: 'full' | 'partial' | 'none';
  includeEquipment: boolean;
  includeFuelSurcharge: boolean;
};

export type Confidence = 'high' | 'medium' | 'low';

export type ExtractedField<T = string | number | null> = {
  value: T;
  confidence: Confidence;
};

export type StopVerification = {
  status: 'verified' | 'mismatch' | 'not_found' | 'pending';
  suggestedCorrection: {
    address: string;
    city: string;
    state: string;
    zip: string;
  } | null;
};

export type ExtractedStop = {
  address: ExtractedField<string | null>;
  city: ExtractedField<string | null>;
  state: ExtractedField<string | null>;
  zip: ExtractedField<string | null>;
  stopOrder: ExtractedField<number>;
  stopType: ExtractedField<string | null>;
  _verification?: StopVerification;
};

export type ExtractedLane = {
  hcr: ExtractedField<string | null>;
  tripNumber: ExtractedField<string | null>;
  contractName: ExtractedField<string | null>;
  contractPeriodStart?: ExtractedField<string | null>;
  contractPeriodEnd?: ExtractedField<string | null>;
  rate?: ExtractedField<number | null>;
  rateType?: ExtractedField<string | null>;
  currency?: ExtractedField<string | null>;
  minimumRate?: ExtractedField<number | null>;
  minimumQuantity?: ExtractedField<number | null>;
  fuelSurchargeType?: ExtractedField<string | null>;
  fuelSurchargeValue?: ExtractedField<number | null>;
  stops?: ExtractedStop[];
  miles?: ExtractedField<number | null>;
  loadCommodity?: ExtractedField<string | null>;
  equipmentClass?: ExtractedField<string | null>;
  equipmentSize?: ExtractedField<string | null>;
  stopOffRate?: ExtractedField<number | null>;
  includedStops?: ExtractedField<number | null>;
  lanePriority?: ExtractedField<string | null>;
  subsidiary?: ExtractedField<string | null>;
  _calculatedMiles?: number | null;
  _selected?: boolean;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type DedupCategory = 'new' | 'update' | 'restore' | 'unchanged';

export type DedupResult = {
  lane: ExtractedLane;
  category: DedupCategory;
  existingId?: string;
  existingData?: Record<string, unknown>;
  isDeleted?: boolean;
  selected: boolean;
};

export type WizardStep = 'upload' | 'configure' | 'extracting' | 'review' | 'import';
