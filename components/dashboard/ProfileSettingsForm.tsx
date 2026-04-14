"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabaseClient } from "@/lib/supabase/client";
import { uploadKYCDocument } from "@/app/actions/kyc-upload";

interface ProfileSettingsFormProps {
  initialName?: string;
  initialPhone?: string;
  initialCountry?: string;
}

export function ProfileSettingsForm({
  initialName = "",
  initialPhone = "",
  initialCountry = "",
}: ProfileSettingsFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);

  const [formData, setFormData] = useState({
    full_name: initialName,
    phone: initialPhone,
    country_code: initialCountry,
  });

  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  function getReadableError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return message;
      }
    }
    return "Failed to update profile.";
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, files } = e.target;
    
    if (name === "government_id" && files?.[0]) {
      setSelectedFile(files[0]);
      console.log(`📄 File selected: ${files[0].name} (${files[0].size} bytes)`);
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
      const supabase = getBrowserSupabaseClient();
      if (!supabase) throw new Error("Supabase client not found");

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user) {
        throw new Error("You must be logged in to update your profile.");
      }

      // Step 1: Update basic profile info (RLS allows update on own row)
      console.log("📝 Updating profile info...");
      const updates = {
        full_name: formData.full_name,
        phone: formData.phone,
        country_code: formData.country_code.toUpperCase(),
      };

      const { data: updatedRows, error: updateError } = await supabase
        .from("profiles")
        .update(updates)
        .eq("id", userData.user.id)
        .select("id");

      if (updateError) throw updateError;
      if (!updatedRows || updatedRows.length === 0) {
        throw new Error(
          "Profile record not found. Please sign out and sign in again, then retry."
        );
      }

      // Step 2: Upload government ID if file selected
      if (selectedFile) {
        console.log("📤 Uploading government ID...");
        setUploadProgress(30);

        const formDataWithFile = new FormData();
        formDataWithFile.append("government_id", selectedFile);

        const uploadResult = await uploadKYCDocument(formDataWithFile);

        if (!uploadResult.success) {
          throw new Error(uploadResult.error || "Failed to upload document");
        }

        console.log(`✅ Document uploaded to Supabase: ${uploadResult.path}`);
        setUploadProgress(100);
      }

      setSuccess(true);
      setUploadProgress(null);
      setTimeout(() => router.refresh(), 500);
    } catch (err: unknown) {
      setError(getReadableError(err));
      setUploadProgress(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="settings-form-group" onSubmit={handleSubmit}>
      {error && <p className="auth-page-error">{error}</p>}
      {success && (
        <p className="form-success-message">
          Profile details saved successfully. Document uploaded for admin review.
        </p>
      )}

      <div className="settings-grid">
        <div className="settings-field">
          <label htmlFor="full_name" className="settings-label">Full Legal Name</label>
          <input
            id="full_name"
            name="full_name"
            type="text"
            className="settings-input"
            value={formData.full_name}
            onChange={handleChange}
            placeholder="e.g. Satoshi Nakamoto"
            required
          />
        </div>

        <div className="settings-field">
          <label htmlFor="phone" className="settings-label">Phone Number</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            className="settings-input"
            value={formData.phone}
            onChange={handleChange}
            placeholder="+1 (555) 000-0000"
            required
          />
        </div>

        <div className="settings-field settings-field--narrow">
          <label htmlFor="country_code" className="settings-label">Country Code</label>
          <input
            id="country_code"
            name="country_code"
            type="text"
            className="settings-input"
            value={formData.country_code}
            onChange={handleChange}
            placeholder="US"
            maxLength={2}
            required
          />
        </div>
      </div>

      <fieldset className="settings-upload-panel">
        <legend className="settings-label settings-upload-legend">Government ID Verification</legend>
        <p className="settings-help-text">
          Upload an official government ID. It is stored in secure Supabase Storage and reviewed by admins only.
        </p>
        <p className="settings-disclaimer settings-disclaimer--rules">
          Accepted files: JPG, PNG, WEBP, or PDF. Maximum size: 10 MB.
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
            File selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(0)} KB)
          </p>
        )}
        {uploadProgress !== null && (
          <div className="settings-progress-track">
            <div
              className="settings-progress-fill"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        )}
      </fieldset>

      <button
        type="submit"
        disabled={loading}
        className="workspace-button workspace-button--primary settings-submit-btn"
      >
        {loading ? "Verifying..." : "Save & Verify Identity"}
      </button>
    </form>
  );
}
