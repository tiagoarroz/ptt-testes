import { Component, OnInit, OnDestroy } from '@angular/core';
import { io } from 'socket.io-client';
import Peer from 'simple-peer';

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
  private socket: any;
  private peers: { [key: string]: any } = {};

  constructor() {
    this.socket = io('http://localhost:3000');
  }

  async ngOnInit() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('Error accessing microphone:', err);
    }

    this.socket.on('channel-users', (users: string[]) => {
      this.connectedUsers = users;
      users.forEach(user => this.createPeerConnection(user, false));
    });

    this.socket.on('user-joined', (userId: string) => {
      this.connectedUsers.push(userId);
      this.createPeerConnection(userId, true);
    });

    this.socket.on('user-left', (userId: string) => {
      this.connectedUsers = this.connectedUsers.filter(id => id !== userId);
      this.talkingUsers = this.talkingUsers.filter(id => id !== userId);
      if (this.peers[userId]) {
        this.peers[userId].destroy();
        delete this.peers[userId];
      }
    });

    this.socket.on('signal', (data: { from: string, signal: any }) => {
      if (this.peers[data.from]) {
        this.peers[data.from].signal(data.signal);
      }
    });

    this.socket.on('talking', (data: { userId: string }) => {
      if (!this.talkingUsers.includes(data.userId)) {
        this.talkingUsers.push(data.userId);
      }
    });

    this.socket.on('stopped-talking', (data: { userId: string }) => {
      this.talkingUsers = this.talkingUsers.filter(id => id !== data.userId);
    });
  }

  joinChannel() {
    if (this.channelId) {
      this.socket.emit('join-channel', this.channelId);
    }
  }

  createPeerConnection(userId: string, initiator: boolean) {
    const peer = new Peer({
      initiator,
      stream: this.stream || undefined,
      trickle: false
    });

    peer.on('signal', (data) => {
      this.socket.emit('signal', { to: userId, signal: data });
    });

    peer.on('stream', (stream: MediaStream) => {
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play();
    });

    this.peers[userId] = peer;
  }

  startTalking() {
    if (this.stream) {
      this.isTalking = true;
      this.stream.getAudioTracks()[0].enabled = true;
      this.socket.emit('talking', { channelId: this.channelId, userId: this.socket.id });
    }
  }

  stopTalking() {
    if (this.stream) {
      this.isTalking = false;
      this.stream.getAudioTracks()[0].enabled = false;
      this.socket.emit('stopped-talking', { channelId: this.channelId, userId: this.socket.id });
    }
  }

  ngOnDestroy() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
    }
    this.socket.disconnect();
    Object.values(this.peers).forEach(peer => peer.destroy());
  }
}