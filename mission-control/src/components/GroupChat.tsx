'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from './GroupChat.module.css';

const initialMessages = [
  {
    id: 1,
    sender: 'Arjun',
    role: 'operator',
    text: 'Starting work on the auth system',
    time: '10:02 AM',
  },
  {
    id: 2,
    sender: 'Pony',
    role: 'operator',
    text: 'did anyone set up rate limiting for the API?',
    time: '10:03 AM',
  },
  {
    id: 3,
    sender: 'Mesh Memory',
    role: 'memory',
    text: 'Yes — Unnath added this 2 days ago.',
    time: '10:03 AM',
    memoryData: {
      key: 'api/rate_limiting',
      value: 'express-rate-limit, 100 req/min per IP',
      addedBy: 'Unnath via Copilot • Jun 10 14:22',
      votes: 'Y: 3 N: 0'
    }
  },
  {
    id: 4,
    sender: "Pony's Agent (Claude Code)",
    role: 'agent',
    time: '10:04 AM',
    decisionData: {
      decision: 'Use JWT over sessions',
      reason: 'Stateless, better for mobile clients',
      affects: '/src/auth/* (4 files)'
    }
  }
];

export default function GroupChat() {
  const [activeTab, setActiveTab] = useState('chat');
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, activeTab]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const userMessage = {
      id: Date.now(),
      sender: 'You',
      role: 'operator',
      text: input,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
  };

  return (
    <div className={styles.chatContainer}>
      <div className={styles.tabsHeader}>
        <div 
          className={`${styles.tab} ${activeTab === 'chat' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('chat')}
        >
          Chat
        </div>
        <div 
          className={`${styles.tab} ${activeTab === 'activity' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('activity')}
        >
          Activity
        </div>
        <div 
          className={`${styles.tab} ${activeTab === 'memory' ? styles.activeTab : ''}`}
          onClick={() => setActiveTab('memory')}
        >
          Memory Search
        </div>
      </div>

      {activeTab === 'chat' && (
        <>
          <div className={`${styles.messagesArea} custom-scrollbar`}>
            {messages.map((msg) => (
              <div key={msg.id} className={styles.messageWrapper}>
                
                {msg.role === 'operator' && (
                  <div className={`${styles.avatar} ${styles.operator}`}>
                    {msg.sender.charAt(0)}
                  </div>
                )}
                {msg.role === 'memory' && (
                  <div className={`${styles.avatar} ${styles.memoryAvatar}`}>M</div>
                )}
                {msg.role === 'agent' && (
                  <div className={`${styles.avatar} ${styles.agentAvatar}`}>A</div>
                )}

                <div className={styles.messageContent}>
                  <div className={styles.messageHeader}>
                    <span className={styles.senderName}>{msg.sender}</span>
                    <span className={styles.timestamp}>{msg.time}</span>
                  </div>
                  
                  {msg.text && <div className={styles.messageText}>{msg.text}</div>}
                  
                  {msg.memoryData && (
                    <div className={styles.memoryEntryBox}>
                      <div className={styles.memRow}><span className={styles.memLabel}>KEY:</span> <span className={styles.memValue}>{msg.memoryData.key}</span></div>
                      <div className={styles.memRow}><span className={styles.memLabel}>VALUE:</span> <span className={styles.memValue}>{msg.memoryData.value}</span></div>
                      <div className={styles.memRow}><span className={styles.memLabel}>ADDED:</span> <span className={styles.memValue}>{msg.memoryData.addedBy}</span></div>
                      <div className={styles.memRow}><span className={styles.memLabel}>VOTES:</span> <span className={styles.memValue}>{msg.memoryData.votes}</span></div>
                      <button className={styles.linkBtn}>[View full entry]</button>
                    </div>
                  )}

                  {msg.decisionData && (
                    <div className={styles.decisionCard}>
                      <div className={styles.decisionRow}><span className={styles.decLabel}>DECISION:</span> {msg.decisionData.decision}</div>
                      <div className={styles.decisionRow}><span className={styles.decLabel}>REASON:</span> {msg.decisionData.reason}</div>
                      <div className={styles.decisionRow}><span className={styles.decLabel}>AFFECTS:</span> {msg.decisionData.affects}</div>
                      
                      <div className={styles.voteSection}>
                        <div className={styles.votePrompt}>Save to shared memory?</div>
                        <div className={styles.voteActions}>
                          <button className={styles.voteBtnYes}>Save</button>
                          <button className={styles.voteBtnNo}>Skip</button>
                          <button className={styles.voteBtnEdit}>Edit</button>
                        </div>
                      </div>
                    </div>
                  )}

                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className={styles.inputArea}>
            <form onSubmit={handleSend} className={styles.inputForm}>
              <button type="button" className={styles.attachBtn}>+</button>
              <input 
                type="text" 
                className={styles.textInput} 
                placeholder="Message team and ask memory..." 
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
              <button type="submit" className={styles.sendBtn}>Send</button>
            </form>
          </div>
        </>
      )}

      {activeTab === 'activity' && (
        <div className={styles.placeholderTab}>
          Activity Stream View (See LogStream)
        </div>
      )}

      {activeTab === 'memory' && (
        <div className={styles.placeholderTab}>
          Memory Search View
        </div>
      )}
    </div>
  );
}
