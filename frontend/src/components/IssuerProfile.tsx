import { Keypair } from '@stellar/stellar-sdk';

const generateKeypair = () => {
  const pair = Keypair.random();

  setFormData((prev) => ({
    ...prev,
    stellarPublicKey: pair.publicKey(),
    stellarSecretKey: pair.secret(),
  }));
};