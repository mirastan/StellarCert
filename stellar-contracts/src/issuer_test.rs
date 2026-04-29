#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

#[test]
fn test_issuer_management() {
    let env = Env::default();
    let contract_id = env.register_contract(None, CertificateContract);
    let client = CertificateContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let issuer1 = Address::generate(&env);
    let issuer2 = Address::generate(&env);

    // Initialize with admin
    client.initialize(&admin);

    // Initial count should be 0
    assert_eq!(client.get_issuer_count(), 0);
    assert_eq!(client.get_issuers().len(), 0);

    // Add first issuer
    env.mock_all_auths();
    client.add_issuer(&issuer1);

    assert_eq!(client.get_issuer_count(), 1);
    assert!(client.is_issuer(&issuer1));
    assert!(!client.is_issuer(&issuer2));

    let issuers = client.get_issuers();
    assert_eq!(issuers.len(), 1);
    assert_eq!(issuers.get(0).unwrap(), issuer1);

    // Add second issuer
    client.add_issuer(&issuer2);

    assert_eq!(client.get_issuer_count(), 2);
    assert!(client.is_issuer(&issuer2));

    let issuers = client.get_issuers();
    assert_eq!(issuers.len(), 2);
    
    // Add issuer1 again (should not increment count or add to list)
    client.add_issuer(&issuer1);
    assert_eq!(client.get_issuer_count(), 2);
    assert_eq!(client.get_issuers().len(), 2);
}
