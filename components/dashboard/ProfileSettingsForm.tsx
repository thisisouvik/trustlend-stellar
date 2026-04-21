"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { updateUserProfile } from "@/app/actions/update-profile";
import { uploadKYCDocument } from "@/app/actions/kyc-upload";

interface ProfileSettingsFormProps {
  initialName?: string;
  initialPhone?: string;
  initialDob?: string;
  kycStatus?: string;
  hasGovId?: boolean;
}

export function ProfileSettingsForm({
  initialName = "",
  initialPhone = "",
  initialDob = "",
  kycStatus = "pending",
  hasGovId = false,
}: ProfileSettingsFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const [formData, setFormData] = useState({
    full_name: initialName,
    phone: initialPhone,
    date_of_birth: initialDob,
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, files } = e.target;

    if (name === "government_id" && files?.[0]) {
      setSelectedFile(files[0]);
    } else {
      setFormData((prev) => ({ ...prev, [name]: value }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);
    setUploadProgress(null);

    try {
      // Step 1: Update profile fields via server action with the signed-in session.
      const result = await updateUserProfile({
        full_name: formData.full_name,
        phone: formData.phone,
        date_of_birth: formData.date_of_birth || undefined,
      });

      if (!result.success) {
        throw new Error(result.error ?? "Failed to update profile.");
      }

      // Step 2: Upload government ID if selected
      if (selectedFile) {
        setUploadProgress(30);

        const formDataWithFile = new FormData();
        formDataWithFile.append("government_id", selectedFile);

        const uploadResult = await uploadKYCDocument(formDataWithFile);

        if (!uploadResult.success) {
          throw new Error(uploadResult.error ?? "Failed to upload document.");
        }

        setUploadProgress(100);
      }

      setSuccess(true);
      setUploadProgress(null);
      // Refresh server-rendered data after a short delay
      setTimeout(() => router.refresh(), 600);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred.");
      setUploadProgress(null);
    } finally {
      setLoading(false);
    }
  };

  const docLocked = hasGovId && kycStatus !== "pending";

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      const { getBrowserSupabaseClient } = await import("@/lib/supabase/client");
      const supabase = getBrowserSupabaseClient();
      if (supabase) {
        await supabase.auth.signOut();
      }
      router.push("/auth");
    } catch (err) {
      console.error("Logout failed:", err);
      setSigningOut(false);
    }
  };

  return (
    <form className="settings-form-group" onSubmit={handleSubmit}>
      {error && (
        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "0.6rem",
            background: "rgba(220,38,38,0.06)",
            border: "1px solid rgba(220,38,38,0.25)",
            color: "#dc2626",
            fontSize: "0.875rem",
            marginBottom: "0.25rem",
          }}
        >
          {error}
        </div>
      )}

      {success && (
        <div
          style={{
            padding: "0.85rem 1rem",
            borderRadius: "0.6rem",
            background: "rgba(34,207,157,0.08)",
            border: "1px solid rgba(34,207,157,0.3)",
            color: "#16a07a",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          ✓ Profile details saved successfully.
          {selectedFile ? " Document submitted for admin review." : ""}
        </div>
      )}

      {/* Legal Identity Fields */}
      <div className="settings-grid">
        <div className="settings-field settings-field--full">
          <label htmlFor="full_name" className="settings-label">
            Full Legal Name
            <span style={{ color: "#ff6b6b", marginLeft: "0.2rem" }}>*</span>
          </label>
          <input
            id="full_name"
            name="full_name"
            type="text"
            className="settings-input"
            value={formData.full_name}
            onChange={handleChange}
            placeholder="As it appears on your government ID"
            required
            autoComplete="name"
          />
          <p className="settings-help-text" style={{ marginTop: "0.25rem" }}>
            Must match your government-issued identification exactly.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="phone" className="settings-label">
            Phone Number
            <span style={{ color: "#ff6b6b", marginLeft: "0.2rem" }}>*</span>
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            className="settings-input"
            value={formData.phone}
            onChange={handleChange}
            placeholder="+91 98765 43210"
            required
            autoComplete="tel"
          />
          <p className="settings-help-text" style={{ marginTop: "0.25rem", color: "#8b5cf6" }}>
            OTP Verification coming soon.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="date_of_birth" className="settings-label">
            Date of Birth
            <span style={{ color: "#ff6b6b", marginLeft: "0.2rem" }}>*</span>
          </label>
          <input
            id="date_of_birth"
            name="date_of_birth"
            type="date"
            className="settings-input"
            value={formData.date_of_birth}
            onChange={handleChange}
            max={
              new Date(Date.now() - 18 * 365.25 * 24 * 60 * 60 * 1000)
                .toISOString()
                .split("T")[0]
            }
            required
          />
          <p className="settings-help-text" style={{ marginTop: "0.25rem" }}>
            Must be 18+ (Required).
          </p>
        </div>
      </div>

      {/* Government ID Upload */}
      <fieldset className="settings-upload-panel" disabled={docLocked}>
        <legend className="settings-label settings-upload-legend">
          Government ID Verification
          {docLocked && (
            <span
              style={{
                marginLeft: "0.6rem",
                fontSize: "0.72rem",
                background: "rgba(34,207,157,0.1)",
                color: "#16a07a",
                padding: "0.15rem 0.5rem",
                borderRadius: "0.3rem",
                fontWeight: 700,
                letterSpacing: "0.04em",
              }}
            >
              SUBMITTED
            </span>
          )}
        </legend>

        {docLocked ? (
          <p className="settings-help-text" style={{ color: "#16a07a", marginBottom: 0 }}>
            ✓ Your government ID has been submitted and is under admin review.
            Contact support if you need to update it.
          </p>
        ) : (
          <>
            <p className="settings-help-text">
              Upload an official government ID (passport, national ID, or
              driver&apos;s license). Stored securely and reviewed by admins only.
            </p>
            <p className="settings-disclaimer settings-disclaimer--rules">
              Accepted: JPG, PNG, WEBP, or PDF · Max size: 10 MB
            </p>
            <p className="settings-disclaimer settings-disclaimer--warning">
              Important: once submitted, this document cannot be changed from your dashboard.
            </p>
            <input
              type="file"
              name="government_id"
              id="government_id"
              className="settings-input settings-input--file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              onChange={handleChange}
            />
            {selectedFile && (
              <p className="settings-file-note">
                Selected: {selectedFile.name} (
                {(selectedFile.size / 1024).toFixed(0)} KB)
              </p>
            )}
            {uploadProgress !== null && (
              <div
                className="settings-progress-track"
                style={{ marginTop: "0.75rem" }}
              >
                <div
                  className="settings-progress-fill"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
          </>
        )}
      </fieldset>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "center",
        }}
      >
        <button
          type="submit"
          disabled={loading}
          className="workspace-button workspace-button--primary settings-submit-btn"
        >
          {loading ? "Saving…" : "Save & Verify Identity"}
        </button>

        <button
          type="button"
          onClick={handleLogout}
          disabled={signingOut}
          className="workspace-button workspace-button--secondary settings-submit-btn"
          style={{ background: "rgba(239,68,68,0.08)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.3)" }}
        >
          {signingOut ? "Signing out…" : "Sign Out"}
        </button>
      </div>
    </form>
  );
}
