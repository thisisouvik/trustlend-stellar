"use client";

import { useState } from "react";
import { verifyKYCDocument } from "@/app/actions/admin-kyc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface KYCDocument {
  id: string;
  email: string;
  full_name: string;
  kyc_status: string;
  government_id_url: string;
  submitted_at: string;
}

export default function AdminKYCClient({
  documents,
}: {
  documents: KYCDocument[];
}) {
  const [selectedDoc, setSelectedDoc] = useState<KYCDocument | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: string; text: string } | null>(
    null
  );

  const handleApprove = async (docId: string) => {
    setLoading(true);
    const result = await verifyKYCDocument(docId, true);
    if (result.success) {
      setMessage({ type: "success", text: "✅ Document approved" });
      setTimeout(() => {
        setSelectedDoc(null);
        setMessage(null);
        window.location.reload();
      }, 1500);
    } else {
      setMessage({ type: "error", text: `❌ ${result.error}` });
    }
    setLoading(false);
  };

  const handleReject = async (docId: string) => {
    if (!rejectionReason) {
      setMessage({ type: "error", text: "Please provide rejection reason" });
      return;
    }

    setLoading(true);
    const result = await verifyKYCDocument(docId, false, rejectionReason);
    if (result.success) {
      setMessage({
        type: "success",
        text: "✅ Document rejected",
      });
      setTimeout(() => {
        setSelectedDoc(null);
        setRejectionReason("");
        setMessage(null);
        window.location.reload();
      }, 1500);
    } else {
      setMessage({ type: "error", text: `❌ ${result.error}` });
    }
    setLoading(false);
  };

  const pendingDocuments = documents.filter((doc) => doc.kyc_status === "submitted");
  const reviewedDocuments = documents.filter((doc) => doc.kyc_status !== "submitted");

  const formatSubmittedDate = (submittedAt: string) => {
    if (!submittedAt) {
      return "Unknown";
    }

    return new Date(submittedAt).toLocaleDateString();
  };

  const isReviewedSelection = selectedDoc ? selectedDoc.kyc_status !== "submitted" : false;

  return (
    <div className="kyc-root">
      <div className="kyc-note">
        <span aria-hidden="true">💡</span>
        <p>
          <strong>Note:</strong> Reviews are currently manual. Automated AI face verification will be added in a future release.
        </p>
      </div>

      <div className="kyc-grid">
        <div className="kyc-list-stack">
          <Card>
            <CardHeader>
              <CardTitle>
                Pending Verification ({pendingDocuments.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {pendingDocuments.length === 0 ? (
                <p style={{ color: "#999", textAlign: "center", padding: "1.5rem 0" }}>
                  No pending documents
                </p>
              ) : (
                <div className="kyc-scroll-list">
                  {pendingDocuments.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => {
                        setSelectedDoc(doc);
                        setMessage(null);
                        setRejectionReason("");
                      }}
                      className={`kyc-doc-row ${selectedDoc?.id === doc.id ? "is-selected-pending" : ""}`}
                    >
                      <div style={{ fontWeight: 600 }}>{doc.full_name}</div>
                      <div style={{ fontSize: "0.85rem", color: "#666" }}>{doc.email}</div>
                      <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "0.25rem" }}>
                        Submitted: {formatSubmittedDate(doc.submitted_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                KYC History
              </CardTitle>
            </CardHeader>
            <CardContent>
              {reviewedDocuments.length === 0 ? (
                <p style={{ color: "#999", textAlign: "center", padding: "1.5rem 0" }}>
                  No reviewed documents
                </p>
              ) : (
                <div className="kyc-scroll-list">
                  {reviewedDocuments.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => {
                        setSelectedDoc(doc);
                        setMessage(null);
                        setRejectionReason("");
                      }}
                      className={`kyc-doc-row ${selectedDoc?.id === doc.id ? "is-selected-reviewed" : ""}`}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ fontWeight: 600 }}>{doc.full_name}</div>
                        <span style={{ fontSize: "0.65rem", fontWeight: 700, padding: "0.2rem 0.5rem", borderRadius: "999px", background: doc.kyc_status === "verified" ? "rgba(34,207,157,0.12)" : "rgba(245,166,35,0.12)", color: doc.kyc_status === "verified" ? "#22cf9d" : "#f5a623" }}>
                          {doc.kyc_status.toUpperCase()}
                        </span>
                      </div>
                      <div style={{ fontSize: "0.85rem", color: "#666" }}>{doc.email}</div>
                      <div style={{ fontSize: "0.75rem", color: "#999", marginTop: "0.25rem" }}>
                        Submitted: {formatSubmittedDate(doc.submitted_at)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="kyc-viewer-panel">
          {selectedDoc ? (
        <Card className="kyc-viewer-card">
          <CardHeader>
            <CardTitle style={{ fontSize: "1rem" }}>
              {selectedDoc.full_name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="kyc-meta-row">
              <span className="kyc-meta-pill">{isReviewedSelection ? "History Record" : "Pending Review"}</span>
              <span className="kyc-meta-text">Submitted: {formatSubmittedDate(selectedDoc.submitted_at)}</span>
            </div>
            {selectedDoc.government_id_url ? (
              <>
                <div
                  style={{
                    marginBottom: "1rem",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0.5rem",
                    overflow: "hidden",
                    backgroundColor: "#f9f9f9",
                    minHeight: "240px",
                  }}
                >
                  {selectedDoc.government_id_url.endsWith(".pdf") ? (
                    <div style={{ padding: "1rem", textAlign: "center" }}>
                      <p style={{ marginBottom: "0.5rem" }}>📄 PDF Document</p>
                      <a
                        href={selectedDoc.government_id_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#4f46e5",
                          textDecoration: "none",
                          fontSize: "0.85rem",
                        }}
                      >
                        View in IPFS →
                      </a>
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element 
                    <img
                      src={selectedDoc.government_id_url}
                      alt="Government ID"
                      style={{ width: "100%", display: "block" }}
                      onError={() =>
                        console.error(
                          "Failed to load image:",
                          selectedDoc.government_id_url
                        )
                      }
                    />
                  )}
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  {message && (
                    <div
                      style={{
                        padding: "0.5rem 0.75rem",
                        marginBottom: "1rem",
                        borderRadius: "0.4rem",
                        backgroundColor:
                          message.type === "success" ? "#dcf5e3" : "#f5dcdc",
                        color:
                          message.type === "success" ? "#22863a" : "#cb2431",
                        fontSize: "0.85rem",
                      }}
                    >
                      {message.text}
                    </div>
                  )}

                  {message?.type === "success" ? null : (
                    <>
                      <div style={{ marginBottom: "1rem" }}>
                        <label
                          style={{
                            display: "block",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            marginBottom: "0.5rem",
                          }}
                        >
                          Reject Reason (optional)
                        </label>
                        <textarea
                          value={rejectionReason}
                          onChange={(e) => setRejectionReason(e.target.value)}
                          placeholder="If rejecting, provide reason..."
                          style={{
                            width: "100%",
                            minHeight: "80px",
                            padding: "0.5rem",
                            border: "1px solid #d3dcf1",
                            borderRadius: "0.4rem",
                            fontFamily: "inherit",
                            fontSize: "0.85rem",
                            resize: "vertical",
                          }}
                        />
                      </div>

                      <div style={{ display: "grid", gap: "0.5rem" }}>
                        <Button
                          onClick={() => handleApprove(selectedDoc.id)}
                          disabled={loading}
                          style={{
                            backgroundColor: "#10b981",
                            color: "white",
                            padding: "0.5rem 1rem",
                            border: "none",
                            borderRadius: "0.4rem",
                            cursor: "pointer",
                          }}
                        >
                          {loading ? "Processing..." : "✅ Approve"}
                        </Button>
                        <Button
                          onClick={() => handleReject(selectedDoc.id)}
                          disabled={loading}
                          style={{
                            backgroundColor: "#ef4444",
                            color: "white",
                            padding: "0.5rem 1rem",
                            border: "none",
                            borderRadius: "0.4rem",
                            cursor: "pointer",
                          }}
                        >
                          {loading ? "Processing..." : "❌ Reject"}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <p style={{ color: "#999" }}>No document uploaded yet</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="kyc-viewer-card">
          <CardHeader>
            <CardTitle style={{ fontSize: "1rem" }}>
              Select a document
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="kyc-empty-state">
              <p style={{ color: "#64748b", textAlign: "center", margin: 0 }}>
                Choose a record from Pending Verification or KYC History to preview details.
              </p>
              <div className="kyc-empty-stats">
                <span>Pending: {pendingDocuments.length}</span>
                <span>History: {reviewedDocuments.length}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
        </div>
      </div>

      <style jsx>{`
        .kyc-root {
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        .kyc-note {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 1rem;
          background: linear-gradient(135deg, rgba(79, 70, 229, 0.08), rgba(14, 165, 233, 0.08));
          border: 1px solid rgba(99, 102, 241, 0.3);
          border-radius: 0.75rem;
          color: #4338ca;
          font-size: 0.9rem;
        }

        .kyc-note p {
          margin: 0;
        }

        .kyc-grid {
          display: grid;
          grid-template-columns: minmax(320px, 1fr) minmax(420px, 1.35fr);
          gap: 1.25rem;
          align-items: stretch;
        }

        .kyc-list-stack {
          display: grid;
          gap: 1rem;
          height: 100%;
        }

        .kyc-scroll-list {
          display: grid;
          gap: 0.75rem;
          max-height: 360px;
          overflow-y: auto;
          padding-right: 0.35rem;
        }

        .kyc-doc-row {
          padding: 0.9rem;
          border: 1px solid #e5e7eb;
          border-radius: 0.6rem;
          cursor: pointer;
          background: #ffffff;
          transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
        }

        .kyc-doc-row:hover {
          border-color: #c7d2fe;
          box-shadow: 0 8px 20px rgba(79, 70, 229, 0.08);
          transform: translateY(-1px);
        }

        .is-selected-pending {
          border: 2px solid #4f46e5;
          background: #eef2ff;
        }

        .is-selected-reviewed {
          border: 2px solid #94a3b8;
          background: #f8fafc;
        }

        .kyc-viewer-panel {
          position: sticky;
          top: 1.5rem;
          align-self: start;
          min-height: 100%;
        }

        .kyc-viewer-card {
          min-height: 680px;
        }

        .kyc-meta-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .kyc-meta-pill {
          display: inline-block;
          padding: 0.2rem 0.65rem;
          border-radius: 999px;
          font-size: 0.75rem;
          font-weight: 700;
          background: rgba(79, 70, 229, 0.14);
          color: #4338ca;
        }

        .kyc-meta-text {
          font-size: 0.8rem;
          color: #64748b;
        }

        .kyc-empty-state {
          min-height: 560px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          border: 1px dashed #cbd5e1;
          border-radius: 0.75rem;
          padding: 1.25rem;
          background: linear-gradient(180deg, rgba(248, 250, 252, 0.95), rgba(241, 245, 249, 0.75));
        }

        .kyc-empty-stats {
          display: flex;
          gap: 0.75rem;
          flex-wrap: wrap;
        }

        .kyc-empty-stats span {
          font-size: 0.8rem;
          color: #334155;
          background: #e2e8f0;
          border: 1px solid #cbd5e1;
          border-radius: 999px;
          padding: 0.2rem 0.65rem;
          font-weight: 600;
        }

        @media (max-width: 1160px) {
          .kyc-grid {
            grid-template-columns: 1fr;
          }

          .kyc-viewer-panel {
            position: static;
          }

          .kyc-viewer-card {
            min-height: 420px;
          }

          .kyc-empty-state {
            min-height: 280px;
          }
        }
      `}</style>
    </div>
  );
}
