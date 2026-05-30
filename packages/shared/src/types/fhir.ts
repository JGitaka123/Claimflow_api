// ============================================================================
// FHIR R4 TYPES — Section 14 (AfyaLink Integration)
// ============================================================================

/** AfyaLink endpoint URLs — parameterized for UAT vs Production */
export const AFYALINK_URLS = {
  UAT: {
    base: 'https://uat-mis.apeiro-digital.com',
    claimSubmit: 'https://uat-mis.apeiro-digital.com/v1/shr-med/bundle',
    clientRegistry: 'https://cr.kenya-hie.health/api/v4/Patient',
    facilityRegistry: 'https://fr.kenya-hie.health/api/v4/Organization',
    eligibility: 'https://uat.dha.go.ke/v1/eligibility',
    preauth: 'https://uat.dha.go.ke/v1/shr-med/bundle',
    artifacts: 'https://kps.dha.go.ke/artifacts.html',
    developerPortal: 'https://developer.dha.go.ke',
  },
  PRODUCTION: {
    base: 'https://mis.apeiro-digital.com',
    claimSubmit: 'https://mis.apeiro-digital.com/v1/shr-med/bundle',
    clientRegistry: 'https://cr.kenya-hie.health/api/v4/Patient',
    facilityRegistry: 'https://fr.kenya-hie.health/api/v4/Organization',
    eligibility: 'https://dha.go.ke/v1/eligibility',
    preauth: 'https://dha.go.ke/v1/shr-med/bundle',
    artifacts: 'https://kps.dha.go.ke/artifacts.html',
    developerPortal: 'https://developer.dha.go.ke',
  },
} as const;

export type AfyaLinkEnv = keyof typeof AFYALINK_URLS;

/** FHIR Coding Systems used by SHA/AfyaLink */
export const FHIR_CODING_SYSTEMS = {
  icd11: 'https://icd.who.int/browse/2024-01/mms',
  shaServiceCodes: 'https://mis.apeiro-digital.com/fhir/terminology/CodeSystem/sha-service-codes',
  claimType: 'http://terminology.hl7.org/CodeSystem/claim-type',
  claimSubtype: 'http://terminology.hl7.org/CodeSystem/ex-claimsubtype',
  encounterClass: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  facilityIdType: 'http://ts-kenyahie.health/facility-identifier-type',
  shaNumberSystem: 'https://mis.apeiro-digital.com/fhir/identifier/shanumber',
  encounterTypes: 'https://shr.kenya-hie.health/encounter-types',
} as const;

/**
 * Entity mapping: ClaimFlow internal ↔ FHIR R4
 * 
 * ClaimFlow claims       → FHIR Claim
 * ClaimFlow patient      → FHIR Patient (Client Registry)
 * ClaimFlow encounter    → FHIR Encounter
 * ClaimFlow practitioner → FHIR Practitioner (Health Worker Registry)
 * ClaimFlow facility     → FHIR Organization (Facility Registry)
 * ClaimFlow documents    → FHIR DocumentReference
 * ClaimFlow audit result → Internal (FHIR ClaimResponse in v2 shadow mode)
 * ClaimFlow preauth      → FHIR Claim (use: preauthorization)
 * ClaimFlow coverage     → FHIR Coverage (from Eligibility API)
 */
export interface FhirEntityMapping {
  claimflow: string;
  fhir: string;
  registry?: string;
}

export const ENTITY_MAPPINGS: FhirEntityMapping[] = [
  { claimflow: 'claims', fhir: 'Claim', registry: 'Claim submission endpoint' },
  { claimflow: 'patient_sha_id', fhir: 'Patient', registry: 'Client Registry (cr.kenya-hie.health)' },
  { claimflow: 'encounter', fhir: 'Encounter', registry: 'SHR' },
  { claimflow: 'practitioner', fhir: 'Practitioner', registry: 'Health Worker Registry' },
  { claimflow: 'facilities', fhir: 'Organization', registry: 'Facility Registry (fr.kenya-hie.health)' },
  { claimflow: 'documents', fhir: 'DocumentReference' },
  { claimflow: 'audit_result', fhir: 'ClaimResponse (v2)' },
  { claimflow: 'preauthorization', fhir: 'Claim (use: preauthorization)', registry: 'SHA Portal Preauth API' },
  { claimflow: 'coverage', fhir: 'Coverage', registry: 'Eligibility API' },
];
