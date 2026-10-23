import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { DevicesPage } from "./pages/mobile/DevicesPage";
import { EscenariosPage } from "./pages/mobile/EscenariosPage";
import { JobLogPage } from "./pages/mobile/JobLogPage";
import { JobsPage } from "./pages/mobile/JobsPage";
import { MobileLayout } from "./pages/mobile/MobileLayout";
import { ReportesPage } from "./pages/mobile/ReportesPage";
import { ScenarioDetailPage } from "./pages/mobile/ScenarioDetailPage";

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
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:jobId" element={<JobLogPage />} />
            <Route path="reportes" element={<ReportesPage />} />
            <Route path="dispositivos" element={<DevicesPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </ErrorBoundary>
    </AuthProvider>
  );
}
