"use client";

import { useState, useRef, useEffect } from "react";

interface Notification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
}

interface NotificationWidgetProps {
  notifications?: Notification[];
}

export function NotificationWidget({ notifications = [] }: NotificationWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <div
      ref={dropdownRef}
      style={{
        position: "relative",
        display: "inline-block",
      }}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="workspace-chip"
        style={{
          position: "relative",
          padding: "0.45rem 0.6rem",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
        aria-label="Notifications"
        aria-expanded={isOpen}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ color: "#7e2fd0" }}
        >
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: "-4px",
              right: "-4px",
              background: "#ff6b6b",
              color: "white",
              borderRadius: "50%",
              width: "18px",
              height: "18px",
              fontSize: "0.65rem",
              fontWeight: "700",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid white",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: "300px",
            maxWidth: "400px",
            maxHeight: "450px",
            background: "white",
            border: "1px solid #dbe3f5",
            borderRadius: "0.85rem",
            boxShadow: "0 10px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08)",
            zIndex: 1000,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "0.95rem 1.1rem",
              borderBottom: "1px solid #e8edf9",
              background: "#f5f8ff",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: "0.9rem",
                fontWeight: "700",
                color: "#28325a",
              }}
            >
              Notifications
            </h3>
            {unreadCount > 0 && (
              <span
                style={{
                  fontSize: "0.75rem",
                  fontWeight: "600",
                  color: "#7e2fd0",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {unreadCount} new
              </span>
            )}
          </div>

          <div
            style={{
              overflowY: "auto",
              flex: 1,
            }}
          >
            {notifications.length === 0 ? (
              <div
                style={{
                  padding: "1.5rem 1.1rem",
                  textAlign: "center",
                }}
              >
                <svg
                  width="40"
                  height="40"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#d4dcf0"
                  strokeWidth="1.5"
                  style={{ marginBottom: "0.5rem" }}
                >
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                <p
                  style={{
                    margin: "0.5rem 0 0",
                    fontSize: "0.85rem",
                    color: "#7a86a8",
                  }}
                >
                  No notifications yet
                </p>
              </div>
            ) : (
              <div>
                {notifications.map((notification) => (
                  <div
                    key={notification.id}
                    style={{
                      padding: "0.95rem 1.1rem",
                      borderBottom: "1px solid #f0f4ff",
                      background: notification.read ? "#ffffff" : "#f9fafd",
                      cursor: "pointer",
                      transition: "background-color 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = notification.read
                        ? "#f5f8ff"
                        : "#f0f3ff";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = notification.read
                        ? "#ffffff"
                        : "#f9fafd";
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        gap: "0.5rem",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                      }}
                    >
                      <div style={{ flex: 1 }}>
                        <p
                          style={{
                            margin: 0,
                            fontSize: "0.87rem",
                            fontWeight: notification.read ? 500 : 600,
                            color: "#28325a",
                          }}
                        >
                          {notification.title}
                        </p>
                        <p
                          style={{
                            margin: "0.25rem 0 0",
                            fontSize: "0.8rem",
                            color: "#627091",
                            lineHeight: 1.4,
                          }}
                        >
                          {notification.message}
                        </p>
                        <p
                          style={{
                            margin: "0.35rem 0 0",
                            fontSize: "0.75rem",
                            color: "#7a86a8",
                          }}
                        >
                          {new Date(notification.timestamp).toLocaleDateString(
                            "en-US",
                            {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            }
                          )}
                        </p>
                      </div>
                      {!notification.read && (
                        <div
                          style={{
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: "#7e2fd0",
                            marginTop: "0.4rem",
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {notifications.length > 0 && (
            <div
              style={{
                padding: "0.75rem 1.1rem",
                borderTop: "1px solid #e8edf9",
                background: "#f9fafc",
                textAlign: "center",
              }}
            >
              <button
                style={{
                  background: "none",
                  border: "none",
                  color: "#7e2fd0",
                  fontSize: "0.8rem",
                  fontWeight: "600",
                  cursor: "pointer",
                  textDecoration: "none",
                }}
                onClick={() => {
                  // Handle view all notifications
                  setIsOpen(false);
                }}
              >
                View All Notifications
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
