use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, IntoVal, String, Vec};

const DEFAULT_UPDATE_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RevocationReason {
    KeyCompromise = 0,
    CACompromise = 1,
    AffiliationChanged = 2,
    Superseded = 3,
    CessationOfOperation = 4,
    CertificateHold = 5,
    PrivilegeWithdrawn = 6,
    AACompromise = 7,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevocationInfo {
    pub certificate_id: String,
    pub reason: u32,
    pub issuer: Address,
    pub revocation_date: u64,
    pub revoked_by: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CRLInfo {
    pub issuer: Address,
    pub revoked_count: u32,
    pub crl_number: u64,
    pub this_update: u64,
    pub next_update: u64,
    pub merkle_root: String,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
enum DataKey {
    Issuer,
    Admin,
    Info,
    Revocation(String),
    RevokedCertificates,
    CertContract,
}

#[contract]
pub struct CRLContract;

#[contractimpl]
impl CRLContract {
    pub fn initialize(env: Env, issuer: Address, certificate_contract: Address) {
        if env.storage().instance().has(&DataKey::Issuer) {
            panic!("CRL already initialized");
        }

        issuer.require_auth();

        let now = env.ledger().timestamp();
        let crl_info = CRLInfo {
            issuer: issuer.clone(),
            revoked_count: 0,
            crl_number: 1,
            this_update: now,
            next_update: now + DEFAULT_UPDATE_WINDOW_SECONDS,
            merkle_root: Self::build_merkle_root(&env, 1),
        };

        env.storage().instance().set(&DataKey::Issuer, &issuer);
        env.storage()
            .instance()
            .set(&DataKey::CertContract, &certificate_contract);
        env.storage()
            .instance()
            .set(&DataKey::RevokedCertificates, &Vec::<String>::new(&env));
        env.storage().instance().set(&DataKey::Info, &crl_info);
    }

    pub fn revoke_certificate(
        env: Env,
        certificate_id: String,
        reason: RevocationReason,
        _serial_number: Option<String>,
    ) {
        let issuer = Self::get_issuer(&env);
        // Allow either the configured issuer or an admin to authorize revocations
        let invoker = env.invoker();
        let mut authorized = false;
        if invoker == issuer {
            authorized = true;
        } else if let Some(admin) = Self::get_admin(&env) {
            if invoker == admin {
                authorized = true;
            }
        }

        if !authorized {
            panic!("Only issuer or admin can revoke");
        }

        // Require auth from the invoker
        invoker.require_auth();

        // Verify the certificate exists in the CertificateContract (#414)
        let cert_contract: Address = env
            .storage()
            .instance()
            .get(&DataKey::CertContract)
            .expect("CRL not initialized");
        let cert_exists: bool = env.invoke_contract(
            &cert_contract,
            &soroban_sdk::Symbol::new(&env, "certificate_exists"),
            soroban_sdk::vec![&env, certificate_id.clone().into_val(&env)],
        );
        if !cert_exists {
            panic!("Certificate does not exist");
        }

        let revocation_key = DataKey::Revocation(certificate_id.clone());
        if env.storage().instance().has(&revocation_key) {
            panic!("Certificate already revoked");
        }

        let mut crl_info = Self::get_crl_info_internal(&env);
        let revocation_info = RevocationInfo {
            certificate_id: certificate_id.clone(),
            reason: reason as u32,
            issuer: issuer.clone(),
            revocation_date: env.ledger().timestamp(),
            revoked_by: invoker.clone(),
        };

        env.storage()
            .instance()
            .set(&revocation_key, &revocation_info);

        let mut revoked_certificates = Self::get_revoked_certificate_ids(&env);
        revoked_certificates.push_back(certificate_id);
        env.storage()
            .instance()
            .set(&DataKey::RevokedCertificates, &revoked_certificates);

        crl_info.revoked_count += 1;
        Self::refresh_crl_info(&env, &mut crl_info);
        env.storage().instance().set(&DataKey::Info, &crl_info);
    }

    pub fn is_revoked(env: Env, certificate_id: String) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::Revocation(certificate_id))
    }

    pub fn get_revocation_info(env: Env, certificate_id: String) -> Option<RevocationInfo> {
        env.storage()
            .instance()
            .get(&DataKey::Revocation(certificate_id))
    }

    pub fn get_revoked_count(env: Env) -> u32 {
        Self::get_crl_info_internal(&env).revoked_count
    }

    pub fn get_crl_info(env: Env) -> CRLInfo {
        Self::get_crl_info_internal(&env)
    }

    pub fn get_revoked_certificates(env: Env, page: u32, limit: u32) -> Vec<RevocationInfo> {
        let revoked_certificates = Self::get_revoked_certificate_ids(&env);
        let mut page_of_revocations = Vec::new(&env);

        if limit == 0 {
            return page_of_revocations;
        }

        let start = page.saturating_mul(limit);
        let mut end = start.saturating_add(limit);
        let total = revoked_certificates.len();
        if end > total {
            end = total;
        }

        let mut index = start;
        while index < end {
            if let Some(certificate_id) = revoked_certificates.get(index) {
                if let Some(revocation_info) = env
                    .storage()
                    .instance()
                    .get(&DataKey::Revocation(certificate_id.clone()))
                {
                    page_of_revocations.push_back(revocation_info);
                }
            }
            index += 1;
        }

        page_of_revocations
    }

    pub fn verify_certificate(env: Env, certificate_id: String) -> (bool, u64) {
        let crl_info = Self::get_crl_info_internal(&env);
        let is_revoked = env
            .storage()
            .instance()
            .has(&DataKey::Revocation(certificate_id));

        (is_revoked, crl_info.crl_number)
    }

    pub fn get_merkle_root(env: Env) -> String {
        Self::get_crl_info_internal(&env).merkle_root
    }

    pub fn update_crl_metadata(env: Env, next_update: Option<u64>, _issuer: Option<Address>) {
        let issuer = Self::get_issuer(&env);
        issuer.require_auth();

        let mut crl_info = Self::get_crl_info_internal(&env);
        if let Some(new_next_update) = next_update {
            crl_info.next_update = new_next_update;
        }

        Self::refresh_crl_info(&env, &mut crl_info);
        env.storage().instance().set(&DataKey::Info, &crl_info);
    }

    /// Set an admin address that can authorize revocations/unrevocations
    pub fn set_admin(env: Env, admin: Address) {
        let issuer = Self::get_issuer(&env);
        issuer.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn needs_update(env: Env) -> bool {
        env.ledger().timestamp() >= Self::get_crl_info_internal(&env).next_update
    }

    fn get_issuer(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Issuer)
            .expect("CRL not initialized")
    }

    fn get_crl_info_internal(env: &Env) -> CRLInfo {
        env.storage()
            .instance()
            .get(&DataKey::Info)
            .expect("CRL info not found")
    }

    fn get_admin(env: &Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    fn get_revoked_certificate_ids(env: &Env) -> Vec<String> {
        match env.storage().instance().get(&DataKey::RevokedCertificates) {
            Some(revoked_certificates) => revoked_certificates,
            None => Vec::new(env),
        }
    }

    fn refresh_crl_info(env: &Env, crl_info: &mut CRLInfo) {
        crl_info.crl_number += 1;
        crl_info.this_update = env.ledger().timestamp();
        crl_info.merkle_root = Self::build_merkle_root(env, crl_info.crl_number);
    }

    fn build_merkle_root(env: &Env, crl_number: u64) -> String {
        if crl_number.is_multiple_of(2) {
            String::from_str(env, "root-even")
        } else {
            String::from_str(env, "root-odd")
        }
    }
}
