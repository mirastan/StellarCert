use soroban_sdk::{contract, contractimpl, Address, Env, String, Vec};

use crate::{
    DataKey, MultisigConfig, OptionalRequestStatus, PaginatedResult, Pagination, PendingRequest,
    RequestStatus, SignatureResult,
};

#![no_std]

use soroban_sdk::{Address, Env, String, Vec};

/// Metadata field types supported by the schema
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum MetadataFieldType {
    String = 0,
    Number = 1,
    Boolean = 2,
    Date = 3,
    Json = 4,
}

impl MetadataFieldType {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(MetadataFieldType::String),
            1 => Some(MetadataFieldType::Number),
            2 => Some(MetadataFieldType::Boolean),
            3 => Some(MetadataFieldType::Date),
            4 => Some(MetadataFieldType::Json),
            _ => None,
        }
    }
}

/// Schema version structure for tracking schema evolution
#[derive(Clone)]
pub struct MetadataSchemaVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl MetadataSchemaVersion {
    pub fn is_greater_than(&self, other: &MetadataSchemaVersion) -> bool {
        if self.major > other.major {
            return true;
        }
        if self.major == other.major && self.minor > other.minor {
            return true;
        }
        if self.major == other.major
            && self.minor == other.minor
            && self.patch > other.patch
        {
            return true;
        }
        false
    }

    pub fn is_equal(&self, other: &MetadataSchemaVersion) -> bool {
        self.major == other.major && self.minor == other.minor && self.patch == other.patch
    }
}

/// A field rule defining constraints for a metadata field
#[derive(Clone)]
pub struct MetadataFieldRule {
    pub name: String,
    pub field_type: MetadataFieldType,
    pub required: bool,
    pub min_length: u32,
    pub max_length: u32,
}

/// A complete metadata schema record
#[derive(Clone)]
pub struct MetadataSchemaRecord {
    pub id: String,
    pub name: String,
    pub version: MetadataSchemaVersion,
    pub fields: Vec<MetadataFieldRule>,
    pub required_fields: Vec<String>,
    pub allow_custom_fields: bool,
    pub created_by: Address,
    pub created_at: u64,
    pub is_active: bool,
    pub previous_version_id: Option<String>,
}

/// A single metadata entry (key-value pair)
#[derive(Clone)]
pub struct MetadataEntry {
    pub key: String,
    pub value: String,
    pub value_type: MetadataFieldType,
}

/// Validation error structure
#[derive(Clone)]
pub struct MetadataValidationError {
    pub field: String,
    pub constraint: String,
    pub message: String,
}

/// Result of metadata validation
#[derive(Clone)]
pub struct MetadataValidationResult {
    pub valid: bool,
    pub errors: Vec<MetadataValidationError>,
}

/// Metadata-related errors
#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum MetadataError {
    SchemaAlreadyExists = 0,
    SchemaNotFound = 1,
    SchemaInactive = 2,
    InvalidVersion = 3,
    ValidationFailed = 4,
    Unauthorized = 5,
}

/// Storage keys for metadata
#[derive(Clone)]
pub enum MetadataKey {
    Schema(String),
    SchemaNameIndex(String), // Maps schema name to latest schema ID
    SchemaHistory(String),   // Maps schema name to list of schema IDs
    SchemaCount,
}

// Implement conversion for MetadataKey to be used as storage key
impl MetadataKey {
    pub fn to_key(&self) -> soroban_sdk::storage::Key {
        match self {
            MetadataKey::Schema(id) => {
                soroban_sdk::storage::Key::try_from_val(&soroban_sdk::Symbol::from_str("md_sch"), id)
                    .unwrap_or_else(|_| soroban_sdk::storage::Key::try_from_val(&0u32, id).unwrap())
            }
            MetadataKey::SchemaNameIndex(name) => {
                soroban_sdk::storage::Key::try_from_val(&soroban_sdk::Symbol::from_str("md_nidx"), name)
                    .unwrap_or_else(|_| soroban_sdk::storage::Key::try_from_val(&1u32, name).unwrap())
            }
            MetadataKey::SchemaHistory(name) => {
                soroban_sdk::storage::Key::try_from_val(&soroban_sdk::Symbol::from_str("md_hist"), name)
                    .unwrap_or_else(|_| soroban_sdk::storage::Key::try_from_val(&2u32, name).unwrap())
            }
            MetadataKey::SchemaCount => {
                soroban_sdk::storage::Key::try_from_val(&soroban_sdk::Symbol::from_str("md_cnt"), &())
                    .unwrap_or_else(|_| soroban_sdk::storage::Key::try_from_val(&3u32, &()).unwrap())
            }
        }
    }
}

/// Register a new metadata schema
pub fn register_schema(env: &Env, schema: MetadataSchemaRecord) -> Result<(), MetadataError> {
    // Check if schema already exists
    if env
        .storage()
        .instance()
        .has(&schema.id)
    {
        return Err(MetadataError::SchemaAlreadyExists);
    }

    // Store the schema
    env.storage()
        .instance()
        .set(&schema.id, &schema);

    // Update name index to point to this schema
    env.storage()
        .instance()
        .set(&schema.name, &schema.id);

    // Update schema count
    let count: u32 = env
        .storage()
        .instance()
        .get(&MetadataKey::SchemaCount)
        .unwrap_or(0);
    env.storage()
        .instance()
        .set(&MetadataKey::SchemaCount, &(count + 1));

    // Initialize schema history if needed
    let mut history: Vec<String> = env
        .storage()
        .instance()
        .get(&schema.name)
        .unwrap_or_else(|| Vec::new(env));
    history.push_back(schema.id.clone());
    env.storage()
        .instance()
        .set(&schema.name, &history);

    Ok(())
}

/// Get a schema by ID
pub fn get_schema(env: &Env, id: &String) -> Option<MetadataSchemaRecord> {
    env.storage().instance().get(id)
}

/// Get the total number of schemas
pub fn get_schema_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&MetadataKey::SchemaCount)
        .unwrap_or(0)
}

/// Get schema history by name
pub fn get_schema_history(env: &Env, name: &String) -> Vec<String> {
    env.storage()
        .instance()
        .get(name)
        .unwrap_or_else(|| Vec::new(env))
}

/// Validate metadata against a schema
pub fn validate_metadata(
    env: &Env,
    schema_id: &String,
    entries: &Vec<MetadataEntry>,
    _cert_id: &String,
) -> MetadataValidationResult {
    let schema = match get_schema(env, schema_id) {
        Some(s) => s,
        None => {
            return MetadataValidationResult {
                valid: false,
                errors: vec![MetadataValidationError {
                    field: String::from_str(env, "schema"),
                    constraint: String::from_str(env, "exists"),
                    message: String::from_str(env, "Schema not found"),
                }],
            };
        }
    };

    // Check if schema is active
    if !schema.is_active {
        return MetadataValidationResult {
            valid: false,
            errors: vec![MetadataValidationError {
                field: String::from_str(env, "schema"),
                constraint: String::from_str(env, "active"),
                message: String::from_str(env, "Schema is inactive"),
            }],
        };
    }

    let mut errors: Vec<MetadataValidationError> = Vec::new(env);

    // Check required fields
    for required_field in schema.required_fields.iter() {
        let found = entries.iter().any(|e| e.key == required_field);
        if !found {
            errors.push(MetadataValidationError {
                field: required_field.clone(),
                constraint: String::from_str(env, "required"),
                message: String::from_str(env, "Required field is missing"),
            });
        }
    }

    // Validate each entry
    for entry in entries.iter() {
        // Find matching field rule
        let field_rule = schema.fields.iter().find(|f| f.name == entry.key);

        if let Some(rule) = field_rule {
            // Check type match
            if rule.field_type != entry.value_type {
                errors.push(MetadataValidationError {
                    field: entry.key.clone(),
                    constraint: String::from_str(env, "type"),
                    message: String::from_str(env, "Field type mismatch"),
                });
            }

            // Check string length constraints for String type
            if entry.value_type == MetadataFieldType::String {
                let len = entry.value.len();
                if len < rule.min_length as u32 {
                    errors.push(MetadataValidationError {
                        field: entry.key.clone(),
                        constraint: String::from_str(env, "minLength"),
                        message: String::from_str(env, "Value too short"),
                    });
                }
                if len > rule.max_length as u32 {
                    errors.push(MetadataValidationError {
                        field: entry.key.clone(),
                        constraint: String::from_str(env, "maxLength"),
                        message: String::from_str(env, "Value too long"),
                    });
                }
            }
        } else {
            // No matching field rule found
            if !schema.allow_custom_fields {
                errors.push(MetadataValidationError {
                    field: entry.key.clone(),
                    constraint: String::from_str(env, "noCustomFields"),
                    message: String::from_str(env, "Custom fields not allowed"),
                });
            }
        }
    }

    MetadataValidationResult {
        valid: errors.is_empty(),
        errors,
    }
}

/// Upgrade a schema to a new version
pub fn upgrade_schema(
    env: &Env,
    old_id: &String,
    new_schema: MetadataSchemaRecord,
) -> Result<(), MetadataError> {
    // Get old schema
    let old_schema = match get_schema(env, old_id) {
        Some(s) => s,
        None => return Err(MetadataError::SchemaNotFound),
    };

    // Check version is greater
    if !new_schema.version.is_greater_than(&old_schema.version) {
        return Err(MetadataError::InvalidVersion);
    }

    // Deactivate old schema
    let mut deactivated = old_schema;
    deactivated.is_active = false;
    env.storage()
        .instance()
        .set(old_id, &deactivated);

    // Register new schema with link to old version
    let mut upgraded = new_schema.clone();
    upgraded.previous_version_id = Some(old_id.clone());

    // Register the new schema
    register_schema(env, upgraded)
}


#[contract]
pub struct MultisigCertificateContract;

#[contractimpl]
impl MultisigCertificateContract {
    /// Initialize multisig configuration for an issuer
    pub fn init_multisig_config(
        env: Env,
        issuer: Address,
        threshold: u32,
        signers: Vec<Address>,
        max_signers: u32,
        admin: Address,
    ) {
        admin.require_auth();

        // Validate parameters
        #[allow(clippy::unnecessary_cast)]
        if threshold == 0
            || signers.is_empty()
            || threshold > signers.len() as u32
            || max_signers < threshold
        {
            panic!("Invalid multisig parameters");
        }

        // Check if already initialized
        if env
            .storage()
            .instance()
            .has(&DataKey::MultisigConfig(issuer.clone()))
        {
            panic!("Multisig config already exists for this issuer");
        }

        // Store configuration
        env.storage().instance().set(
            &DataKey::MultisigConfig(issuer.clone()),
            &MultisigConfig {
                threshold,
                signers,
                max_signers,
            },
        );

        // Store admin for this issuer
        env.storage()
            .instance()
            .set(&DataKey::IssuerAdmin(issuer), &admin);
    }

    /// Update multisig configuration
    pub fn update_multisig_config(
        env: Env,
        issuer: Address,
        new_threshold: Option<u32>,
        new_signers: Option<Vec<Address>>,
        new_max_signers: Option<u32>,
    ) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::IssuerAdmin(issuer.clone()))
            .expect("Issuer admin not found");
        admin.require_auth();

        let mut config: MultisigConfig = env
            .storage()
            .instance()
            .get(&DataKey::MultisigConfig(issuer.clone()))
            .expect("Multisig config not found");

        // Update configuration
        if let Some(signers) = new_signers {
            config.signers = signers;
        }
        if let Some(threshold) = new_threshold {
            config.threshold = threshold;
        }
        if let Some(max_signers) = new_max_signers {
            config.max_signers = max_signers;
        }

        // Validate updated configuration
        #[allow(clippy::unnecessary_cast)]
        if config.threshold == 0
            || config.signers.is_empty()
            || config.threshold > config.signers.len() as u32
            || config.max_signers < config.threshold
        {
            panic!("Invalid updated multisig parameters");
        }

        env.storage()
            .instance()
            .set(&DataKey::MultisigConfig(issuer), &config);
    }

    /// Get multisig configuration for an issuer
    pub fn get_multisig_config(env: Env, issuer: Address) -> MultisigConfig {
        env.storage()
            .instance()
            .get(&DataKey::MultisigConfig(issuer))
            .expect("Multisig config not found")
    }

    /// Propose a certificate for multisig approval
    pub fn propose_certificate(
        env: Env,
        request_id: String,
        issuer: Address,
        recipient: Address,
        metadata: String,
        expiration_days: u32,
    ) -> PendingRequest {
        let config: MultisigConfig = env
            .storage()
            .instance()
            .get(&DataKey::MultisigConfig(issuer.clone()))
            .expect("Issuer does not have multisig configuration");

        // Check if request already exists
        if env
            .storage()
            .instance()
            .has(&DataKey::PendingRequest(request_id.clone()))
        {
            panic!("Request already exists");
        }

        let request = PendingRequest {
            id: request_id.clone(),
            issuer: issuer.clone(),
            recipient: recipient.clone(),
            metadata: metadata.clone(),
            proposer: issuer.clone(),
            approvals: Vec::new(&env),
            rejections: Vec::new(&env),
            rejection_reason: None,
            created_at: env.ledger().timestamp(),
            expires_at: env.ledger().timestamp() + (expiration_days as u64 * 24 * 60 * 60), // Convert days to seconds
            status: RequestStatus::Pending,
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingRequest(request_id.clone()), &request);

        Self::append_request_id(&env, DataKey::IssuerRequestIds(issuer), request_id.clone());

        for signer in config.signers.iter() {
            Self::append_request_id(&env, DataKey::SignerRequestIds(signer), request_id.clone());
        }

        request
    }

    /// Approve a pending certificate request
    pub fn approve_request(env: Env, request_id: String, approver: Address) -> SignatureResult {
        approver.require_auth();

        let mut request: PendingRequest = env
            .storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id.clone()))
            .expect("Request not found");

        // Check if request has expired
        if env.ledger().timestamp() > request.expires_at {
            request.status = RequestStatus::Expired;
            env.storage()
                .instance()
                .set(&DataKey::PendingRequest(request_id), &request);
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Request has expired"),
                final_status: OptionalRequestStatus::Some(RequestStatus::Expired),
            };
        }

        // Check if request is still pending
        if request.status != RequestStatus::Pending {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Request is not pending"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Get multisig configuration
        let config: MultisigConfig = env
            .storage()
            .instance()
            .get(&DataKey::MultisigConfig(request.issuer.clone()))
            .expect("Multisig config not found");

        // Check if approver is an authorized signer
        if !config.signers.contains(&approver) {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Approver is not an authorized signer"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Check if already approved
        if request.approvals.contains(&approver) {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Request already approved by this signer"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Add approval
        request.approvals.push_back(approver);

        // Check if threshold is reached
        if request.approvals.len() >= config.threshold {
            request.status = RequestStatus::Approved;
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingRequest(request_id), &request);

        SignatureResult {
            success: true,
            message: String::from_str(&env, "Approval recorded"),
            final_status: OptionalRequestStatus::Some(request.status),
        }
    }

    /// Reject a pending certificate request
    pub fn reject_request(
        env: Env,
        request_id: String,
        rejector: Address,
        reason: Option<String>,
    ) -> SignatureResult {
        rejector.require_auth();

        let mut request: PendingRequest = env
            .storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id.clone()))
            .expect("Request not found");

        // Check if request is still pending
        if request.status != RequestStatus::Pending {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Request is not pending"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Get multisig configuration
        let config: MultisigConfig = env
            .storage()
            .instance()
            .get(&DataKey::MultisigConfig(request.issuer.clone()))
            .expect("Multisig config not found");

        // Check if rejector is an authorized signer
        if !config.signers.contains(&rejector) {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Rejector is not an authorized signer"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Check if already rejected
        if request.rejections.contains(&rejector) {
            return SignatureResult {
                success: false,
                message: String::from_str(&env, "Request already rejected by this signer"),
                final_status: OptionalRequestStatus::Some(request.status),
            };
        }

        // Add rejection
        request.rejections.push_back(rejector);
        if reason.is_some() {
            request.rejection_reason = reason;
        }

        let remaining_eligible_approvers = config
            .signers
            .len()
            .saturating_sub(request.rejections.len());
        if remaining_eligible_approvers < config.threshold {
            request.status = RequestStatus::Rejected;
        }

        env.storage()
            .instance()
            .set(&DataKey::PendingRequest(request_id), &request);

        SignatureResult {
            success: true,
            message: String::from_str(&env, "Rejection recorded"),
            final_status: OptionalRequestStatus::Some(request.status),
        }
    }

    /// Issue an approved certificate
    pub fn issue_approved_certificate(env: Env, request_id: String) -> bool {
        let mut request: PendingRequest = env
            .storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id.clone()))
            .expect("Request not found");

        if request.status != RequestStatus::Approved {
            return false;
        }

        // This would typically call the main certificate contract
        // For now, we just update the status
        request.status = RequestStatus::Issued;
        env.storage()
            .instance()
            .set(&DataKey::PendingRequest(request_id), &request);
        true
    }

    /// Get a pending request by ID
    pub fn get_pending_request(env: Env, request_id: String) -> PendingRequest {
        env.storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id))
            .expect("Request not found")
    }

    /// Check if a request has expired
    pub fn is_expired(env: Env, request_id: String) -> bool {
        let request: PendingRequest = env
            .storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id))
            .expect("Request not found");
        env.ledger().timestamp() > request.expires_at
    }

    /// Cancel a pending request (only proposer can cancel)
    pub fn cancel_request(env: Env, request_id: String, requester: Address) -> bool {
        requester.require_auth();

        let mut request: PendingRequest = env
            .storage()
            .instance()
            .get(&DataKey::PendingRequest(request_id.clone()))
            .expect("Request not found");

        if request.proposer != requester {
            panic!("Only proposer can cancel the request");
        }

        if request.status != RequestStatus::Pending {
            return false;
        }

        request.status = RequestStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::PendingRequest(request_id), &request);
        true
    }

    /// Get pending requests for an issuer (simplified pagination)
    pub fn get_pending_requests_for_issuer(
        env: Env,
        issuer: Address,
        pagination: Pagination,
    ) -> PaginatedResult {
        Self::paginate_requests(
            &env,
            Self::get_request_ids(&env, DataKey::IssuerRequestIds(issuer)),
            pagination,
        )
    }

    /// Get pending requests for a signer (simplified pagination)
    pub fn get_pending_requests_for_signer(
        env: Env,
        signer: Address,
        pagination: Pagination,
    ) -> PaginatedResult {
        Self::paginate_requests(
            &env,
            Self::get_request_ids(&env, DataKey::SignerRequestIds(signer)),
            pagination,
        )
    }

    fn append_request_id(env: &Env, key: DataKey, request_id: String) {
        let mut request_ids = Self::get_request_ids(env, key.clone());

        if !request_ids.contains(&request_id) {
            request_ids.push_back(request_id);
            env.storage().instance().set(&key, &request_ids);
        }
    }

    fn get_request_ids(env: &Env, key: DataKey) -> Vec<String> {
        env.storage()
            .instance()
            .get(&key)
            .unwrap_or(Vec::<String>::new(env))
    }

    fn paginate_requests(
        env: &Env,
        request_ids: Vec<String>,
        pagination: Pagination,
    ) -> PaginatedResult {
        let mut pending_requests = Vec::<PendingRequest>::new(env);

        for request_id in request_ids.iter() {
            if let Some(request) = env
                .storage()
                .instance()
                .get::<_, PendingRequest>(&DataKey::PendingRequest(request_id))
            {
                if request.status == RequestStatus::Pending {
                    pending_requests.push_back(request);
                }
            }
        }

        let total = pending_requests.len();
        let mut page_data = Vec::<PendingRequest>::new(env);

        if pagination.limit == 0 {
            return PaginatedResult {
                data: page_data,
                total,
                page: pagination.page,
                limit: pagination.limit,
                has_next: false,
            };
        }

        // Page is 1-indexed. Calculate start index (0-indexed)
        let start = pagination.page.saturating_sub(1).saturating_mul(pagination.limit);
        let end = total.min(start.saturating_add(pagination.limit));

        let mut index = start;
        while index < end {
            if let Some(request) = pending_requests.get(index) {
                page_data.push_back(request);
            }
            index += 1;
        }

        PaginatedResult {
            data: page_data,
            total,
            page: pagination.page,
            limit: pagination.limit,
            has_next: end < total,
        }
    }
}
