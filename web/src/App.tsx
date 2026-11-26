import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { DevicesPage } from "./pages/mobile/DevicesPage";
import { EscenariosPage } from "./pages/mobile/EscenariosPage";
import { HistorialPage } from "./pages/mobile/HistorialPage";
import { JobLogPage } from "./pages/mobile/JobLogPage";
import { MobileLayout } from "./pages/mobile/MobileLayout";
import { ScenarioDetailPage } from "./pages/mobile/ScenarioDetailPage";
import { StatusPage } from "./pages/mobile/StatusPage";

export function App() {
  return (
    <AuthProvider>
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <LandingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/mobile"
            element={
              <ProtectedRoute roles={["e2e-mobile"]}>
                <MobileLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="escenarios" replace />} />
            <Route path="escenarios" element={<EscenariosPage />} />
            <Route path="escenarios/:scenarioId" element={<ScenarioDetailPage />} />
            <Route path="historial" element={<HistorialPage />} />
            <Route path="jobs/:jobId" element={<JobLogPage />} />
            <Route path="status" element={<StatusPage />} />
            <Route path="dispositivos" element={<DevicesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </AuthProvider>
  );
}
