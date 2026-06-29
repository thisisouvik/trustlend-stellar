# TrustLend API Integration Guide

This guide describes how third-party platforms and integrations can query TrustLend lending/borrowing pools and fetch credit reputation scores for borrowers on the Stellar network.

## Base URL

All requests should be made to the root domain hosting the TrustLend application:

```http
https://trustlend.xyz/api
```
*(For local development, use `http://localhost:3000/api`)*

---

## 1. Retrieve Lending Pools

Fetch the active liquidity pools on the platform, including current deposit interest rates (APR) and liquidity statuses.

### Endpoint
`GET /api/pools`

### Query Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `status` | `string` | No | Filter pools by status (`active` or `paused`). |
| `limit` | `integer` | No | Limit the number of pools returned (default: `10`, max: `100`). |

### Headers
```http
Accept: application/json
```

### Response Payload (200 OK)
```json
{
  "success": true,
  "pools": [
    {
      "id": "c1f77d33-e5d4-4a57-873d-fb499c7f9999",
      "name": "USDC Yield Pool A",
      "description": "High yield micro-lending pool for verified borrowers",
      "status": "active",
      "apr_bps": 1200,
      "total_liquidity": 150000,
      "available_liquidity": 120000,
      "created_at": "2026-06-25T21:27:34.000Z"
      "id": "b0f77d33-a5a4-4a27-811c-fb567c7f8888",
      "name": "XLM Liquidity Pool Alpha",
      "description": "Base pool for standard XLM micro-loans",
      "status": "active",
      "apr_bps": 1500,
      "total_liquidity": 50000,
      "available_liquidity": 35000,
      "created_at": "2026-06-26T18:11:38.000Z"
    }
  ]
}
```

### Examples

#### cURL
```bash
curl -X GET "https://trustlend.xyz/api/pools?status=active&limit=5" \
  -H "Accept: application/json"
```

#### JavaScript (Fetch)
```javascript
fetch("https://trustlend.xyz/api/pools?status=active&limit=5", {
  method: "GET",
  headers: {
    "Accept": "application/json"
  }
})
  .then(response => response.json())
  .then(data => console.log(data))
  .catch(error => console.error("Error fetching pools:", error));
```

---

## 2. Check Borrower Reputation

Check the trust score, credit tier, borrowing limits, and historical credit events for any borrower registered on the platform by their Stellar public key.

### Endpoint
`GET /api/reputation`

### Query Parameters

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `address` | `string` | **Yes** | The public Stellar wallet key of the borrower (e.g. `GB...`). |

### Headers
```http
Accept: application/json
```

### Response Payload (200 OK)
```json
{
  "success": true,
  "address": "GB2R...EXAMPLE",
  "borrower_name": "Jane Doe",
  "reputation": {
    "score": 520,
    "tier": "Gold",
    "limit_xlm": 5200,
    "updated_at": "2026-06-27T13:39:40.000Z"
  },
  "history": [
    {
      "id": "e2c88f4d-175a-49bf-a86d-0075fffa99aa",
      "event_type": "loan_repay",
      "points": 50,
      "description": "On-time repayment of Loan #11",
      "created_at": "2026-06-27T13:02:37.000Z"
    },
    {
      "id": "a9d88f4d-165a-48bf-a86d-0075fffa88bb",
      "event_type": "kyc_approve",
      "points": 250,
      "description": "KYC Identity verification approved",
      "created_at": "2026-06-26T06:05:27.000Z"
    }
  ]
}
```

### Error Responses

#### Missing Wallet Address (400 Bad Request)
```json
{
  "error": "wallet address is required"
}
```

#### Profile Not Found (404 Not Found)
```json
{
  "error": "Borrower profile not found for this address"
}
```

### Examples

#### cURL
```bash
curl -X GET "https://trustlend.xyz/api/reputation?address=GB2R23XNZKHY77777777777777777777777777777777777777777777" \
  -H "Accept: application/json"
```

#### JavaScript (Fetch)
```javascript
const walletAddress = "GB2R23XNZKHY77777777777777777777777777777777777777777777";

fetch(`https://trustlend.xyz/api/reputation?address=${walletAddress}`, {
  method: "GET",
  headers: {
    "Accept": "application/json"
  }
})
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      console.log(`Borrower Trust Score: ${data.reputation.score} (${data.reputation.tier})`);
    } else {
      console.error("Failed to check reputation:", data.error);
    }
  })
  .catch(error => console.error("Network error:", error));
```
