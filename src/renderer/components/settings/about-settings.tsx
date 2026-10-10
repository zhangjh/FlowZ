import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { ExternalLink, Loader2 } from 'lucide-react';
import {
  getVersionInfo,
  checkForUpdates,
  openExternal,
} from '@/bridge/api-wrapper';

interface VersionInfo {
  appVersion: string;
  appName: string;
  buildDate: string;
  singBoxVersion: string;
  copyright: string;
  repositoryUrl: string;
}

export function AboutSettings() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);


  useEffect(() => {
    loadVersionInfo();
  }, []);

  const loadVersionInfo = async () => {
    try {
      setLoading(true);
      const response = await getVersionInfo();
      if (response && response.success && response.data) {
        setVersionInfo(response.data);
      }
    } catch (error) {
      console.error('Failed to load version info:', error);
      toast.error('无法加载版本信息');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadAndInstall = async (updateInfo: any) => {
    // 无签名机制：直接用浏览器打开下载链接，用户手动下载安装
    const url = updateInfo.downloadUrl || updateInfo.releasePage;
    if (url) {
      openExternal(url);
      toast.info('已在浏览器打开下载页面', {
        description: '请下载安装包后手动安装',
      });
    } else {
      toast.error('无可用下载链接');
    }
  };

  const handleCheckUpdate = async () => {
    try {
      setCheckingUpdate(true);
      toast.info('正在检查更新...');
      
      const response = await checkForUpdates();
      
      if (!response || !response.success) {
        toast.error('检查更新失败', {
          description: response?.error || '无法连接到更新服务器',
        });
        return;
      }

      const data = response.data;
      if (!data) {
        toast.error('检查更新失败', {
          description: '返回数据格式错误',
        });
        return;
      }

      if (data.hasUpdate && data.updateInfo) {
        const updateInfo = data.updateInfo;
        toast.success(`发现新版本 ${updateInfo.version}`, {
          description: '点击下载并安装',
          action: {
            label: '立即更新',
            onClick: () => handleDownloadAndInstall(updateInfo),
          },
          duration: 15000,
        });
      } else {
        toast.success('当前已是最新版本');
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
      toast.error('检查更新失败', {
        description: error instanceof Error ? error.message : '网络错误或服务器不可用',
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleOpenGitHub = async () => {
    const url = versionInfo?.repositoryUrl || 'https://github.com/zhangjh/FlowZ';
    await openExternal(url);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>关于</CardTitle>
          <CardDescription>应用程序信息</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>关于</CardTitle>
        <CardDescription>应用程序信息</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-muted-foreground">应用版本</h4>
            <p className="text-lg font-semibold">
              {versionInfo?.appName || 'FlowZ'} v{versionInfo?.appVersion || '1.0.0'}
            </p>
          </div>

          <Separator />

          <div>
            <h4 className="text-sm font-medium text-muted-foreground">sing-box 版本</h4>
            <p className="text-lg font-semibold">{versionInfo?.singBoxVersion || 'Unknown'}</p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Button
              onClick={handleCheckUpdate}
              disabled={checkingUpdate}
              className="w-full sm:w-auto"
            >
              {checkingUpdate && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {checkingUpdate ? '检查中...' : '检查更新'}
            </Button>
          </div>

          <Separator />

          <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground">开源项目</h4>
            <Button variant="outline" onClick={handleOpenGitHub} className="w-full sm:w-auto">
              <ExternalLink className="mr-2 h-4 w-4" />
              GitHub
            </Button>
          </div>

          <Separator />

          <div className="text-xs text-muted-foreground space-y-1">
            <p>{versionInfo?.copyright || '© 2025 FlowZ. All rights reserved.'}</p>
            <p>基于 sing-box 构建的跨平台客户端代理应用</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
