export interface SwapOrder {
  transaction: string;
  lastValidBlockHeight?: number;
  requestId?: string;
  errorMessage?: string;
  error?: string;
  inUsdValue?: number | string;
  outAmount?: string;
}

export interface WalletBalance {
  mint: string;
  rawAmount: bigint;
  decimals: number;
  uiAmount: number;
}

export interface ParsedInstruction {
  parsed?: {
    type?: string;
    info?: {
      mint?: string;
    };
  };
}

export interface InnerInstruction {
  instructions: ParsedInstruction[];
}

export interface TxTokenBalance {
  mint: string;
  owner: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
  };
}

export interface TransactionData {
  transaction?: {
    message?: {
      instructions: ParsedInstruction[];
    };
  };
  meta?: {
    innerInstructions?: InnerInstruction[];
    postTokenBalances?: TxTokenBalance[];
    preTokenBalances?: TxTokenBalance[];
  };
}
