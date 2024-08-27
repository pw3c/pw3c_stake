import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { SolanaTokenStaking } from "../target/types/solana_token_staking";
import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  transfer,
  mintTo,
  createMint
} from "@solana/spl-token";
import { ASSOCIATED_PROGRAM_ID } from '@coral-xyz/anchor/dist/cjs/utils/token';

describe("solana-token-staking", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaTokenStaking as Program<SolanaTokenStaking>;
  const PROGRAM_ID = program.programId;

  const STATE_SEED = "state";

  const myWallet = provider.wallet;
  const payer = provider.wallet as anchor.Wallet;
  const myPubkey = myWallet.publicKey;

  const myKeypair = anchor.web3.Keypair.generate();
  const keypair1 = anchor.web3.Keypair.generate();
  const keypair2 = anchor.web3.Keypair.generate();

  const pubkey0 = myKeypair.publicKey;
  const pubkey1 = keypair1.publicKey;
  const pubkey2 = keypair2.publicKey;

  const HUNDRED = new BN(100000000000);
  const THOUSAND = new BN(1000000000000);

  const INIT_TIME = "2020-05-19T05:00:00-04:00";
  const LOCK_TIME0 = 1 * 30 * 24 * 3600;
  const LOCK_TIME2 = 3 * 30 * 24 * 3600;

  const getStatePDA = async (owner: PublicKey) => {
    return (
      await PublicKey.findProgramAddressSync(
        [Buffer.from(STATE_SEED), owner.toBuffer()],
        PROGRAM_ID
      )
    )[0];
  };

  const getPoolPDA = async (mint: PublicKey, donationIdentifier: number) => {
    return (
      await PublicKey.findProgramAddressSync(
        [mint.toBuffer(), Uint8Array.from([donationIdentifier])],
        PROGRAM_ID
      )
    )[0];
  };

  const getUserPDA = async (pool: PublicKey, user: PublicKey) => {
    return (
      await PublicKey.findProgramAddressSync(
        [pool.toBuffer(), user.toBuffer()],
        PROGRAM_ID
      )
    )[0];
  };

  const getVaultPDA = (mintKeypair: PublicKey, owner: PublicKey): PublicKey => {
    return getAssociatedTokenAddressSync(
      mintKeypair,
      owner,
      true
    );
  }; 

  const airdropSol = async (
    provider: anchor.AnchorProvider,
    target: PublicKey,
    lamps: number
  ): Promise<string> => {
    try {
      const sig: string = await provider.connection.requestAirdrop(target, lamps);
      await provider.connection.confirmTransaction(sig);
      return sig;
    } catch (e) {
      console.error("Airdrop failed:", e);
      throw e;
    }
  };

  console.log(`My pubkey: ${myPubkey}`);
  console.log(`pubkey0: ${pubkey0}`);
  console.log(`pubkey1: ${pubkey1}`);
  console.log(`pubkey2: ${pubkey2}`);

  let tokenMint = null;
  let globalPDA = null;
  let myGlobalPDA = null;
  let poolPDA0 = null;
  let poolPDA1 = null;
  let userPDA0 = null;
  let userPDA1 = null;
  let poolVaultPDA0 = null;
  let poolVaultPDA1 = null;
  let ownerVaultPDA = null;
  let devVaultPDA = null;
  let userVaultPDA0 = null;
  let userVaultPDA1 = null;

  it("Program is initialized!", async () => {
    await airdropSol(provider, payer.payer.publicKey, 100000000000);
    await airdropSol(provider, myPubkey, 100000000000);
    await airdropSol(provider, pubkey0, 100000000000);
    await airdropSol(provider, pubkey1, 10000000000);
    await airdropSol(provider, pubkey2, 10000000000);

    tokenMint = await createMint(provider.connection, payer.payer, myPubkey, myPubkey, 6);
    console.log(`tokenMint address: ${tokenMint}`);

    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenMint,
      myPubkey
    );

    let signature = await mintTo(
      provider.connection,
      payer.payer,
      tokenMint,
      tokenAccount.address,
      myPubkey,
      1000000000000000
    );
    console.log('mint tx:', signature);

    const toDevAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenMint,
      pubkey0,
      true
    );

    const toTokenAccount1 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenMint,
      pubkey1,
      true
    );

    const toTokenAccount2 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      tokenMint,
      pubkey2,
      true
    );

    signature = await transfer(
      provider.connection,
      payer.payer,
      tokenAccount.address,
      toTokenAccount1.address,
      myPubkey,
      1000000000000
    );

    console.log('transfer tx:', signature);

    signature = await transfer(
      provider.connection,
      payer.payer,
      tokenAccount.address,
      toTokenAccount2.address,
      myPubkey,
      1000000000000
    );
  
    console.log('transfer tx:', signature);

    let info = await getAccount(provider.connection, tokenAccount.address);
    console.log(`tokenAccount amount: ${info.amount}`);
    info = await getAccount(provider.connection, toTokenAccount1.address);
    console.log(`tokenAccount1 amount: ${info.amount}`);
    info = await getAccount(provider.connection, toTokenAccount2.address);
    console.log(`tokenAccount2 amount: ${info.amount}`);

    globalPDA = await getStatePDA(myPubkey);
    console.log(`globalPDA: ${globalPDA}`);
    
    const tx = await program.methods
      .createState(new BN(1))
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        rewardMint: tokenMint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId
      })
      .rpc();
    console.log("Program is initialied by owner", tx);
  });

  it("Pool 0 is created!", async () => {
    poolPDA0 = await getPoolPDA(tokenMint, 0);
    poolVaultPDA0 = await getVaultPDA(tokenMint, poolPDA0);
    console.log(`poolPDA0 address: ${poolPDA0}`);
    console.log(`poolVaultPDA0 address: ${poolVaultPDA0}`);

    const tx = await program.methods
      .createPool(HUNDRED, new BN(1), new BN(25), new BN(LOCK_TIME0), new BN(10))
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        mint: tokenMint,
        vault: poolVaultPDA0,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Pool 0 is created by owner", tx);
  });

  it("Pool 1 is created!", async () => {
    poolPDA1 = await getPoolPDA(tokenMint, 1);
    poolVaultPDA1 = await getVaultPDA(tokenMint, poolPDA1);
    console.log(`poolPDA1 address: ${poolPDA1}`);
    console.log(`poolVaultPDA1 address: ${poolVaultPDA1}`);

    let tx = await program.methods
      .createPool(THOUSAND, new BN(1), new BN(30), new BN(LOCK_TIME2), new BN(10))
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        pool: poolPDA1,
        mint: tokenMint,
        vault: poolVaultPDA1,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Pool 1 is created by owner", tx);

    tx = await program.methods
      .updatePool(0, new BN(20), 1)
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        pool: poolPDA1,
      })
      .rpc();

    console.log("Pool 1 is updated by owner", tx);

    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, poolVaultPDA1);
    console.log(`poolVaultPDA1 amount: ${info.amount}`);
  });

  it("Reward is funded!", async () => {
    ownerVaultPDA = await getVaultPDA(tokenMint, myPubkey);
    console.log(`ownerVaultPDA address: ${ownerVaultPDA}`);

    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, ownerVaultPDA);
    console.log(`ownerVaultPDA amount: ${info.amount}`);
    
    const tx = await program.methods
      .fundRewardToken(THOUSAND, 0)
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        rewardVault: poolVaultPDA0,
        userVault: ownerVaultPDA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    console.log("Reward is funded by owner", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, ownerVaultPDA);
    console.log(`ownerVaultPDA amount: ${info.amount}`);
  });

  it("User 0 is created in pool 0!", async () => {
    userPDA0 = await getUserPDA(poolPDA0, pubkey1);
    console.log(`userPDA0 address: ${userPDA0}`);
    
    const tx = await program.methods
      .createUser(0)
      .accounts({
        authority: pubkey1,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA0,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair1])
      .rpc();

    console.log("User 0 is created in pool 0", tx);
  });

  it("User 1 is created in pool 0!", async () => {
    userPDA1 = await getUserPDA(poolPDA0, pubkey2);
    console.log(`userPDA1 address: ${userPDA1}`);
    
    const tx = await program.methods
      .createUser(0)
      .accounts({
        authority: pubkey2,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA1,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair2])
      .rpc();

    console.log("User 1 is created in pool 0", tx);
  });

  it("User 0 is staked in pool 0!", async () => {
    userVaultPDA0 = getVaultPDA(tokenMint, pubkey1);
    console.log(`userVaultPDA0 address: ${userVaultPDA0}`);

    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);

    const tx = await program.methods
      .stake(new BN(1000), 0)
      .accounts({
        authority: pubkey1,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA0,
        mint: tokenMint,
        poolVault: poolVaultPDA0,
        userVault: userVaultPDA0,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair1])
      .rpc();

    console.log("User 0 is staked in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);
  });

  it("User 1 is staked in pool 0!", async () => {
    userVaultPDA1 = getVaultPDA(tokenMint, pubkey2);
    console.log(`userVaultPDA1 address: ${userVaultPDA1}`);
  
    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);

    const tx = await program.methods
      .stake(new BN(1000), 0)
      .accounts({
        authority: pubkey2,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA1,
        mint: tokenMint,
        poolVault: poolVaultPDA0,
        userVault: userVaultPDA1,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair2])
      .rpc();

    console.log("User 1 is staked in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);
  });

  it("User 0 is unstaked in pool 0!", async () => {
    // const poolInfo = await program.account.farmPoolAccount.all();
    // console.log("poolInfo =", poolInfo);
    // const userInfo = await program.account.farmPoolUserAccount.all();
    // console.log("userInfo =", userInfo);
    // const stateInfo = await program.account.stateAccount.all();
    // console.log("stateInfo =", stateInfo);

    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);

    const tx = await program.methods
      .unstake(new BN(1000), 0)
      .accounts({
        authority: pubkey1,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA0,
        mint: tokenMint,
        poolVault: poolVaultPDA0,
        userVault: userVaultPDA0,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair1])
      .rpc();

    console.log("User 0 is unstaked in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);
  });

  it("User 1 is unstaked in pool 0!", async () => {
    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);

    const tx = await program.methods
      .unstake(new BN(1000), 0)
      .accounts({
        authority: pubkey2,
        owner: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        user: userPDA1,
        mint: tokenMint,
        poolVault: poolVaultPDA0,
        userVault: userVaultPDA1,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair2])
      .rpc();

    console.log("User 1 is unstaked in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);
  });

  it("User 0 is harvested in pool 0!", async () => {
    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);

    const tx = await program.methods
      .harvest(0)
      .accounts({
        authority: pubkey1,
        owner: myPubkey,
        pool: poolPDA0,
        user: userPDA0,
        mint: tokenMint,
        rewardVault: poolVaultPDA0,
        userVault: userVaultPDA0,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair1])
      .rpc();

    console.log("User 0 is harvested in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA0);
    console.log(`userVaultPDA0 amount: ${info.amount}`);
  });

  it("User 1 is harvested in pool 0!", async () => {
    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);

    const tx = await program.methods
      .harvest(0)
      .accounts({
        authority: pubkey2,
        owner: myPubkey,
        pool: poolPDA0,
        user: userPDA1,
        mint: tokenMint,
        rewardVault: poolVaultPDA0,
        userVault: userVaultPDA1,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .signers([keypair2])
      .rpc();

    console.log("User 1 is harvested in pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, userVaultPDA1);
    console.log(`userVaultPDA1 amount: ${info.amount}`);
  });

  it("Program is reinitialized by dev!", async () => {
    myGlobalPDA = await getStatePDA(pubkey0);
    console.log(`My global PDA: ${myGlobalPDA}`);
    devVaultPDA = await getVaultPDA(tokenMint, pubkey0);
    console.log(`devVaultPDA: ${devVaultPDA}`);

    let tx = await program.methods
      .createState(new BN(1))
      .accounts({
        authority: pubkey0,
        state: myGlobalPDA,
        rewardMint: tokenMint,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId
      })
      .signers([myKeypair])
      .rpc();
    console.log("Program is reinitialized by dev", tx);

    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, devVaultPDA);
    console.log(`devVaultPDA amount: ${info.amount}`);

    tx = await program.methods
      .withdraw(new BN(1000000000000), 0)
      .accounts({
        authority: pubkey0,
        state: myGlobalPDA,
        pool: poolPDA0,
        // mint: tokenMint,
        rewardVault: poolVaultPDA0,
        userVault: devVaultPDA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        // associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        // systemProgram: web3.SystemProgram.programId,
      })
      .signers([myKeypair])
      .rpc();

    console.log("Owner withdrew pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, devVaultPDA);
    console.log(`devVaultPDA amount: ${info.amount}`);
  });

  it("Owner withdrew pool 0!", async () => {
    let info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, ownerVaultPDA);
    console.log(`ownerVaultPDA amount: ${info.amount}`);

    const tx = await program.methods
      .withdraw(new BN(200), 0)
      .accounts({
        authority: myPubkey,
        state: globalPDA,
        pool: poolPDA0,
        // mint: tokenMint,
        rewardVault: poolVaultPDA0,
        userVault: ownerVaultPDA,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        // associatedTokenProgram: ASSOCIATED_PROGRAM_ID,
        // systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

    console.log("Owner withdrew pool 0", tx);

    info = await getAccount(provider.connection, poolVaultPDA0);
    console.log(`poolVaultPDA0 amount: ${info.amount}`);
    info = await getAccount(provider.connection, ownerVaultPDA);
    console.log(`ownerVaultPDA amount: ${info.amount}`);
  });
});
