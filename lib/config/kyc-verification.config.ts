/**
 * KYC Verification Configuration
 * 
 * Enhanced security configuration for KYC verification process
 * Based on Level 5 user feedback: Strengthen fraud detection and validation
 * 
 * Implementation: Stricter validation rules, enhanced document verification,
 * improved fraud detection mechanisms
 */

export const KYC_VERIFICATION_CONFIG = {
  // Enhanced validation strictness
  validation: {
    strict_mode: true,
    require_face_verification: true,
    document_liveness_check: true,
    additional_verification_questions: true,
  },
  
  // Fraud detection thresholds
  fraud_detection: {
    enable_ml_scoring: true,
    risk_score_threshold: 0.3,
    geographic_velocity_check: true,
    document_tampering_detection: true,
    duplicate_submission_check: true,
  },
  
  // Document verification
  documents: {
    require_government_id: true,
    support_biometric_matching: true,
    enable_document_expiry_check: true,
    require_recent_proof_of_address: true,
  },
  
  // Implementation date
  implemented_date: '2026-04-25',
  feedback_source: 'Level 5 User: Souvik Mandal',
  feedback_priority: 'CRITICAL',
};

export const getKYCConfig = () => KYC_VERIFICATION_CONFIG;
