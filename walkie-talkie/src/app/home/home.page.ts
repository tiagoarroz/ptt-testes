import { Component, OnInit, OnDestroy, ChangeDetectorRef } from '@angular/core';
import { io } from 'socket.io-client';
import Peer from 'simple-peer';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  standalone: false
})
export class HomePage implements OnInit, OnDestroy {
  channelId: string = '';
  stream: MediaStream | null = null;
  isTalking: boolean = false;
  connectedUsers: string[] = [];
  talkingUsers: string[] = [];
  public socket: any;
  private peers: { [key: string]: any } = {};
  public userId: string = '';
  private isHolding: boolean = false;
  hasJoinError: boolean = false;
  isSocketReady: boolean = false;
  connectionError: string | null = null;
  isRetrying: boolean = false; // Track retry state for spinner

  constructor(private cdr: ChangeDetectorRef) {
    this.socket = io(environment.signalingServerUrl, {
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 2000,
      transports: ['websocket', 'polling'],
      withCredentials: true
    });
  }

  async ngOnInit() {
    await this.initializeStream();

    // Start persistent retry loop after initial failure
    const startPersistentRetry = () => {
      if (!this.isSocketReady) {
        this.retryConnect();
        setTimeout(startPersistentRetry, 2000); // Retry every 2 seconds
      }
    };

    // Show retry button and start persistent retries after 2 seconds
    setTimeout(() => {
      if (!this.isSocketReady) {
        this.connectionError = 'Não foi possível conectar ao servidor. Tentando novamente...';
        this.isRetrying = true;
        startPersistentRetry();
        this.cdr.detectChanges();
      }
    }, 2000);

    this.socket.on('connect', () => {
      console.log('Connected to signaling server, socket.id:', this.socket.id);
      this.userId = this.socket.id;
      this.isSocketReady = true;
      this.connectionError = null;
      this.isRetrying = false;
      this.hasJoinError = false;
      if (this.channelId) {
        this.joinChannel();
      }
      this.cdr.detectChanges();
    });

    this.socket.on('connect_error', (err: any) => {
      console.error('Socket connection error:', err.message, 'Timestamp:', new Date().toISOString());
      this.isSocketReady = false;
      this.connectionError = `Erro de conexão: ${err.message}`;
      this.cdr.detectChanges();
    });

    this.socket.on('reconnect_attempt', (attempt: number) => {
      console.log('Reconnection attempt:', attempt, 'Timestamp:', new Date().toISOString());
      this.connectionError = `Tentando reconectar... (Tentativa ${attempt}/10)`;
      this.isRetrying = true;
      this.cdr.detectChanges();
    });

    this.socket.on('reconnect', (attempt: number) => {
      console.log('Reconnected after', attempt, 'attempts', 'Timestamp:', new Date().toISOString());
      this.connectionError = null;
      this.isRetrying = false;
      this.cdr.detectChanges();
    });

    this.socket.on('reconnect_failed', () => {
      console.error('Reconnection failed after all attempts', 'Timestamp:', new Date().toISOString());
      this.connectionError = 'Falha na reconexão. Tentando novamente...';
      this.isRetrying = true;
      this.cdr.detectChanges();
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from signaling server', 'Timestamp:', new Date().toISOString());
      this.isSocketReady = false;
      this.userId = '';
      this.hasJoinError = true;
      this.connectionError = 'Desconectado do servidor. Tentando reconectar...';
      this.isRetrying = true;
      this.cdr.detectChanges();
    });

    this.socket.on('channel-users', (users: string[]) => {
      console.log('Received channel users:', users);
      this.connectedUsers = users;
      Object.keys(this.peers).forEach(userId => {
        if (!users.includes(userId)) {
          this.peers[userId].destroy();
          delete this.peers[userId];
        }
      });
      users.forEach(user => this.createPeerConnection(user, false));
      console.log('Updated connectedUsers:', this.connectedUsers);
      this.cdr.detectChanges();
    });

    this.socket.on('user-joined', (userId: string) => {
      console.log('User joined:', userId);
      if (!this.connectedUsers.includes(userId)) {
        this.connectedUsers.push(userId);
        this.createPeerConnection(userId, true);
        console.log('Added to connectedUsers:', this.connectedUsers);
        this.cdr.detectChanges();
      }
    });

    this.socket.on('user-left', (userId: string) => {
      console.log('User left:', userId);
      this.connectedUsers = this.connectedUsers.filter(id => id !== userId);
      this.talkingUsers = this.talkingUsers.filter(id => id !== userId);
      if (this.peers[userId]) {
        this.peers[userId].destroy();
        delete this.peers[userId];
      }
      console.log('Removed from connectedUsers:', this.connectedUsers);
      this.cdr.detectChanges();
    });

    this.socket.on('signal', (data: { from: string; signal: any }) => {
      console.log('Received signal from:', data.from);
      if (this.peers[data.from]) {
        this.peers[data.from].signal(data.signal);
      }
    });

    this.socket.on('talking', (data: { userId: string }) => {
      console.log('User talking:', data.userId, 'Current talkingUsers:', this.talkingUsers);
      if (data.userId && !this.talkingUsers.includes(data.userId)) {
        this.talkingUsers.push(data.userId);
        console.log('Added to talkingUsers:', this.talkingUsers);
        this.cdr.detectChanges();
      } else if (!data.userId) {
        console.warn('Received invalid talking event, missing userId:', data);
      }
    });

    this.socket.on('stopped-talking', (data: { userId: string }) => {
      console.log('User stopped talking:', data.userId, 'Current talkingUsers:', this.talkingUsers);
      if (data.userId) {
        this.talkingUsers = this.talkingUsers.filter(id => id !== data.userId);
        console.log('Updated talkingUsers:', this.talkingUsers);
        this.cdr.detectChanges();
      } else {
        console.warn('Received invalid stopped-talking event, missing userId:', data);
      }
    });
  }

  async initializeStream() {
    try {
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
        this.stream = null;
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone access granted');
      Object.values(this.peers).forEach(peer => {
        peer.addStream(this.stream);
      });
      this.cdr.detectChanges();
    } catch (err) {
      console.error('Error accessing microphone:', err);
      this.stream = null;
      alert('Microphone access is required for the walkie-talkie to work.');
      this.cdr.detectChanges();
    }
  }

  joinChannel() {
    if (this.channelId && this.socket.connected && this.userId && this.isSocketReady) {
      console.log('Joining channel:', this.channelId, 'with userId:', this.userId);
      Object.values(this.peers).forEach(peer => peer.destroy());
      this.peers = {};
      this.connectedUsers = [];
      this.talkingUsers = [];
      this.isTalking = false;
      if (this.stream) {
        this.stream.getAudioTracks().forEach(track => (track.enabled = false));
      }
      this.socket.emit('join-channel', this.channelId);
      this.hasJoinError = false;
      this.cdr.detectChanges();
    } else {
      console.warn('Cannot join channel:', {
        channelId: this.channelId,
        connected: this.socket.connected,
        userId: this.userId,
        isSocketReady: this.isSocketReady
      });
      this.hasJoinError = true;
      this.cdr.detectChanges();
    }
  }

  onChannelChange() {
    console.log('Channel selected:', this.channelId);
    this.hasJoinError = false;
    if (this.isSocketReady) {
      this.joinChannel();
    } else {
      console.log('Socket not ready, delaying joinChannel');
    }
    this.cdr.detectChanges();
  }

  retryConnect() {
    console.log('Retrying socket connection', 'Timestamp:', new Date().toISOString());
    this.connectionError = 'Tentando reconectar...';
    this.isRetrying = true;
    this.socket.disconnect();
    console.log('Socket disconnected, attempting reconnect');
    this.socket.connect();
    this.cdr.detectChanges();
  }

  createPeerConnection(userId: string, initiator: boolean) {
    if (!this.stream) {
      console.error('No stream available for peer connection');
      return;
    }

    console.log('Creating peer connection for user:', userId, 'initiator:', initiator);
    const peer = new Peer({
      initiator,
      stream: this.stream,
      trickle: false
    });

    peer.on('signal', (data) => {
      console.log('Sending signal to:', userId);
      this.socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (stream: MediaStream) => {
      console.log('Received stream from:', userId);
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play().catch(err => console.error('Audio playback error:', err));
    });

    peer.on('error', (err) => {
      console.error('Peer error for user:', userId, err);
    });

    peer.on('close', () => {
      console.log('Peer closed:', userId);
      delete this.peers[userId];
    });

    this.peers[userId] = peer;
  }

  startTalking(event: Event) {
    event.preventDefault();
    if (this.stream && this.socket.connected && !this.isHolding && this.userId) {
      console.log('Starting to talk, userId:', this.userId);
      this.isHolding = true;
      this.isTalking = true;
      this.stream.getAudioTracks().forEach(track => {
        track.enabled = true;
        console.log('Track enabled:', track.enabled);
      });
      this.socket.emit('talking', { channelId: this.channelId, userId: this.userId });
      this.cdr.detectChanges();
    } else {
      console.warn('Cannot start talking:', {
        stream: !!this.stream,
        connected: this.socket.connected,
        isHolding: this.isHolding,
        userId: this.userId
      });
    }
  }

  stopTalking(event: Event) {
    event.preventDefault();
    if (this.stream && this.socket.connected && this.isHolding && this.userId) {
      console.log('Stopping talk, userId:', this.userId);
      this.isHolding = false;
      this.isTalking = false;
      this.stream.getAudioTracks().forEach(track => {
        track.enabled = false;
        console.log('Track enabled:', track.enabled);
      });
      this.socket.emit('stopped-talking', { channelId: this.channelId, userId: this.userId });
      this.cdr.detectChanges();
    } else {
      console.warn('Cannot stop talking:', {
        stream: !!this.stream,
        connected: this.socket.connected,
        isHolding: this.isHolding,
        userId: this.userId
      });
    }
  }

  ngOnDestroy() {
    console.log('Destroying component');
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    this.socket.disconnect();
    Object.values(this.peers).forEach(peer => peer.destroy());
  }
}