import React from 'react';
import GlobalHeader from '@/components/GlobalHeader';
import Sidebar from '@/components/Sidebar';
import ProjectDashboard from '@/components/ProjectDashboard';
import RelayBrainPanel from '@/components/RelayBrainPanel';
import CollaboratorsPanel from '@/components/CollaboratorsPanel';
import TaskQueue from '@/components/TaskQueue';
import WorkspaceRail from '@/components/WorkspaceRail';
import styles from './page.module.css';

export default function Home() {
  return (
    <div className={styles.appWrapper}>
      <WorkspaceRail />
      <div className={styles.layout}>
        <GlobalHeader />

        <main className={styles.mainArea}>
          <Sidebar />

          <div className={styles.chatArea}>
            <ProjectDashboard />
          </div>

          <div className={`${styles.controlRoomArea} custom-scrollbar`}>
            <RelayBrainPanel />
            <CollaboratorsPanel />
            <div className={styles.stackPanel}>
              <TaskQueue />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
