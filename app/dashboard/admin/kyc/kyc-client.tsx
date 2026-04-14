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
      setSelectedDoc(null);
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
        text: "✅ Document rejected with reason",
      });
      setSelectedDoc(null);
      setRejectionReason("");
    } else {
      setMessage({ type: "error", text: `❌ ${result.error}` });
    }
    setLoading(false);
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "2rem" }}>
      {/* Document List */}
      <Card>
        <CardHeader>
          <CardTitle>
            Pending Verification ({documents.filter(d => d.kyc_status === "submitted").length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {documents.length === 0 ? (
            <p style={{ color: "#999", textAlign: "center", padding: "2rem" }}>
              No pending documents
            </p>
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => setSelectedDoc(doc)}
                  style={{
                    padding: "1rem",
                    border:
                      selectedDoc?.id === doc.id
                        ? "2px solid #4f46e5"
                        : "1px solid #e5e7eb",
                    borderRadius: "0.5rem",
                    cursor: "pointer",
                    backgroundColor:
                      selectedDoc?.id === doc.id ? "#f0f4ff" : "transparent",
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{doc.full_name}</div>
                  <div style={{ fontSize: "0.85rem", color: "#666" }}>
                    {doc.email}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#999",
                      marginTop: "0.25rem",
                    }}
                  >
                    Submitted:{" "}
                    {new Date(doc.submitted_at).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Document Viewer */}
      {selectedDoc ? (
        <Card>
          <CardHeader>
            <CardTitle style={{ fontSize: "1rem" }}>
              {selectedDoc.full_name}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedDoc.government_id_url ? (
              <>
                <div
                  style={{
                    marginBottom: "1rem",
                    border: "1px solid #e5e7eb",
                    borderRadius: "0.5rem",
                    overflow: "hidden",
                    backgroundColor: "#f9f9f9",
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
                    }}
                  />
                </div>

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
            ) : (
              <p style={{ color: "#999" }}>No document uploaded yet</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle style={{ fontSize: "1rem" }}>
              Select a document
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p style={{ color: "#999", textAlign: "center" }}>
              Choose a pending review from the list
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
