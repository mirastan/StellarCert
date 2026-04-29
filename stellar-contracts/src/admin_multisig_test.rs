#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String, Vec};

#[test]
fn test_admin_multisig_flow() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AdminMultisigContract);
    let client = AdminMultisigContractClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(admin1.clone());
    signers.push_back(admin2.clone());
    signers.push_back(admin3.clone());

    env.mock_all_auths();

    // Initialize with 2-of-3 multisig and a 10-ledger proposal window.
    client.init_admin_multisig(&2, &signers, &10);

    let proposal_id = String::from_str(&env, "prop-1");
    let action = AdminAction::Other(String::from_str(&env, "custom_action"));

    let proposal = client.propose_action(&proposal_id, &admin1, &action);

    assert_eq!(proposal.status, AdminProposalStatus::Pending);
    assert_eq!(proposal.created_ledger, env.ledger().sequence());
    assert_eq!(proposal.expires_at_ledger, env.ledger().sequence() + 10);

    // Admin2 approves (now 1-of-2)
    let status1 = client.approve_action(&proposal_id, &admin2);
    assert_eq!(status1, AdminProposalStatus::Pending);

    // Admin3 approves (now 2-of-2), reaches threshold, autocompletes
    let status2 = client.approve_action(&proposal_id, &admin3);
    assert_eq!(status2, AdminProposalStatus::Executed);

    let stored_proposal = client.get_proposal(&proposal_id);
    assert_eq!(stored_proposal.status, AdminProposalStatus::Executed);
}
#[test]
fn test_remove_issuer_action_executes_after_threshold() {
    let env = Env::default();
    let admin_multisig_contract_id = env.register_contract(None, AdminMultisigContract);
    let client = AdminMultisigContractClient::new(&env, &admin_multisig_contract_id);
    let certificate_contract_id = env.register_contract(None, CertificateContract);
    let certificate_client = CertificateContractClient::new(&env, &certificate_contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let admin3 = Address::generate(&env);
    let issuer = Address::generate(&env);
    let owner = Address::generate(&env);

    let mut signers = Vec::new(&env);
    signers.push_back(admin1.clone());
    signers.push_back(admin2.clone());
    signers.push_back(admin3.clone());

    env.mock_all_auths();

    certificate_client.initialize(&admin_multisig_contract_id);
    certificate_client.add_issuer(&issuer);

    client.init_admin_multisig(&2, &signers, &5);
    client.set_certificate_contract(&admin1, &certificate_contract_id);

    let proposal_id = String::from_str(&env, "remove-issuer-1");
    let action = AdminAction::RemoveIssuer(issuer.clone());

    client.propose_action(&proposal_id, &admin1, &action);
    assert!(!client.is_issuer_removed(&issuer));

    client.approve_action(&proposal_id, &admin2);
    assert!(!client.is_issuer_removed(&issuer));

    let status = client.approve_action(&proposal_id, &admin3);
    assert_eq!(status, AdminProposalStatus::Executed);
    assert!(client.is_issuer_removed(&issuer));

    let issue_result = certificate_client.try_issue_certificate(
        &String::from_str(&env, "issuer-removed-cert"),
        &issuer,
        &owner,
        &String::from_str(&env, "ipfs://meta"),
        &None,
    );
    assert!(issue_result.is_err());
}

#[test]
#[should_panic(expected = "Proposer cannot approve their own action")]
fn test_proposer_cannot_approve() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AdminMultisigContract);
    let client = AdminMultisigContractClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let admin2 = Address::generate(&env);
    let mut signers = Vec::new(&env);
    signers.push_back(admin1.clone());
    signers.push_back(admin2.clone());

    env.mock_all_auths();
    client.init_admin_multisig(&2, &signers, &10);

    let proposal_id = String::from_str(&env, "prop-fail");
    let action = AdminAction::Other(String::from_str(&env, "fail_action"));

    client.propose_action(&proposal_id, &admin1, &action);
    client.approve_action(&proposal_id, &admin1);
}

#[test]
fn test_cancel_proposal() {
    let env = Env::default();
    let contract_id = env.register_contract(None, AdminMultisigContract);
    let client = AdminMultisigContractClient::new(&env, &contract_id);

    let admin1 = Address::generate(&env);
    let signers = Vec::from_array(&env, [admin1.clone()]);

    env.mock_all_auths();
    client.init_admin_multisig(&1, &signers, &10);

    let proposal_id = String::from_str(&env, "prop-cancel");
    let action = AdminAction::Other(String::from_str(&env, "to_be_canceled"));

    client.propose_action(&proposal_id, &admin1, &action);
    let proposal = client.get_proposal(&proposal_id);
    assert_eq!(proposal.status, AdminProposalStatus::Pending);

    client.cancel_proposal(&proposal_id, &admin1);
    let canceled_proposal = client.get_proposal(&proposal_id);
    assert_eq!(canceled_proposal.status, AdminProposalStatus::Rejected);
}
