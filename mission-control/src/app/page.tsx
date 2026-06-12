import React from 'react';
import GlobalHeader from '@/components/GlobalHeader';
import Sidebar from '@/components/Sidebar';
import GroupChat from '@/components/GroupChat';
import ContextMemory from '@/components/ContextMemory';
import TaskQueue from '@/components/TaskQueue';
import InfrastructureBar from '@/components/InfrastructureBar';
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
            <GroupChat />
          </div>

          <div className={`${styles.controlRoomArea} custom-scrollbar`}>
            <div className={styles.stackPanel}>
              <ContextMemory />
            </div>
            <div className={styles.stackPanel}>
              <TaskQueue />
            </div>
          </div>
        </main>

        <InfrastructureBar />
      </div>
    </div>
  );
}
