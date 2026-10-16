/** Probes SDF testnet RPC event-retention stability across repeated calls. */
const RPC = 'https://soroban-testnet.stellar.org';
const DEPLOYMENT_LEDGER = 5166775;

async function rpc(method, params) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function main() {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const result = await rpc('getEvents', {
        startLedger: DEPLOYMENT_LEDGER,
        filters: [
          {
            type: 'contract',
            contractIds: ['CALMZTI56TEDERLWXZJOS5TAN4QN2B36NAJK26MWKND4H5IG4NLPWEJ2'],
          },
        ],
        pagination: { limit: 1 },
      });
      console.log(
        `probe ${attempt}: OK n=${result.events.length} oldest=${result.oldestLedger} latest=${result.latestLedger}`,
      );
    } catch (error) {
      console.log(`probe ${attempt}: ERROR ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const latest = await rpc('getLatestLedger', {});
  console.log(`chain tip: ${latest.sequence}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
