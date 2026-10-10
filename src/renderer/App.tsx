import { useEffect, useState } from 'react';
import { MainLayout } from './components/layout/main-layout';
import { useAppStore } from './store/app-store';
import { useNativeEventListeners } from './hooks/use-native-events';
import { HomePage } from './pages/home-page';
import { ServerPage } from './pages/server-page';
import { RulesPage } from './pages/rules-page';
import { SettingsPage } from './pages/settings-page';
import { Toaster } from './components/ui/sonner';
import { SpeedTestResultDialog, SpeedTestResultItem } from './components/speed-test-result-dialog';
import { ErrorBoundary } from './components/error-boundary';
import { ipcClient } from './ipc';

function App() {
  const [speedTestResults, setSpeedTestResults] = useState<SpeedTestResultItem[]>([]);
  const [speedTestDialogOpen, setSpeedTestDialogOpen] = useState(false);
  const currentView = useAppStore((state) => state.currentView);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const loadConfig = useAppStore((state) => state.loadConfig);
  const refreshConnectionStatus = useAppStore((state) => state.refreshConnectionStatus);

  useNativeEventListeners();

  useEffect(() => {
    loadConfig().then(() => refreshConnectionStatus());
  }, [loadConfig, refreshConnectionStatus]);

  // Listen to navigate events from main process (tray menu)
  useEffect(() => {
    const routeMap: Record<string, string> = {
      '/settings': 'settings',
      '/home': 'home',
      '/server': 'server',
      '/rules': 'rules',
    };

    const unsubscribe = ipcClient.on<string>('navigate', (route) => {
      const view = routeMap[route];
      if (view) {
        setCurrentView(view);
      }
    });

    return () => unsubscribe();
  }, [setCurrentView]);

  // Listen to speed test results
  useEffect(() => {
    const unsubscribe = ipcClient.on<Array<{ name: string; protocol: string; latency: number | null }>>(
      'speedTestResult',
      (results: SpeedTestResultItem[]) => {
        setSpeedTestResults(results);
        setSpeedTestDialogOpen(true);
      }
    );

    return () => unsubscribe();
  }, []);

  return (
    <ErrorBoundary>
      <MainLayout currentView={currentView} onViewChange={setCurrentView}>
        {currentView === 'home' && <HomePage />}

        {currentView === 'server' && <ServerPage />}

        {currentView === 'rules' && <RulesPage />}

        {currentView === 'settings' && <SettingsPage />}
      </MainLayout>
      <Toaster position="top-right" closeButton />
      <SpeedTestResultDialog
        open={speedTestDialogOpen}
        onOpenChange={setSpeedTestDialogOpen}
        results={speedTestResults}
      />
    </ErrorBoundary>
  );
}

export default App;
