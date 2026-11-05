// What the fund pays for, at what price, and which visit record proves it happened.
export const FEE_SYSTEM = 'https://tunza.health/fee-schedule';

export type Category = 'wound-care' | 'medication' | 'hygiene' | 'transport';
export type EvidenceType = 'Procedure' | 'MedicationDispense' | 'ServiceRequest';

export interface Fee {
  label: string;
  price: number; // USD per unit
  category: Category;
  evidence: EvidenceType;
}

export const FEE_SCHEDULE: Record<string, Fee> = {
  'wound-dressing':       { label: 'Wound dressing',       price: 6.0,  category: 'wound-care', evidence: 'Procedure' },
  'insulin-glargine-pen': { label: 'Insulin glargine pen', price: 8.0,  category: 'medication', evidence: 'MedicationDispense' },
  'antibiotic-course':    { label: 'Antibiotics course',   price: 17.0, category: 'medication', evidence: 'MedicationDispense' },
  'hygiene-kit':          { label: 'Hygiene kit',          price: 3.5,  category: 'hygiene',    evidence: 'Procedure' },
  'transport-voucher':    { label: 'Transport voucher',    price: 4.0,  category: 'transport',  evidence: 'ServiceRequest' },
};
