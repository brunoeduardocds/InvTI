// ==============================================================================
// SUPABASE SYNC MODULE - Sincronização em Nuvem e Tempo Real (Multi-dispositivo)
// ==============================================================================

const SUPABASE_STORAGE_URL_KEY = 'invbecs_supabase_url';
const SUPABASE_STORAGE_ANON_KEY = 'invbecs_supabase_anon_key';
const SUPABASE_STORAGE_ENABLED = 'invbecs_supabase_enabled';
const LEGACY_STORAGE_URL_KEY = 'invti_supabase_url';
const LEGACY_STORAGE_ANON_KEY = 'invti_supabase_anon_key';
const LEGACY_STORAGE_ENABLED = 'invti_supabase_enabled';

const supabaseSync = {
  client: null,
  isConnected: false,
  isSyncing: false,
  subscription: null,

  // Inicializa o cliente e testa conexão se configurado
  async init() {
    const url = localStorage.getItem(SUPABASE_STORAGE_URL_KEY) || localStorage.getItem(LEGACY_STORAGE_URL_KEY);
    const key = localStorage.getItem(SUPABASE_STORAGE_ANON_KEY) || localStorage.getItem(LEGACY_STORAGE_ANON_KEY);
    const enabled = (localStorage.getItem(SUPABASE_STORAGE_ENABLED) || localStorage.getItem(LEGACY_STORAGE_ENABLED)) !== 'false';

    this.updateCloudStatusBadge('connecting', 'Conectando...');

    if (!url || !key || !enabled) {
      this.isConnected = false;
      this.updateCloudStatusBadge('local', 'Modo Local');
      return false;
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.warn('Supabase SDK não foi carregado pelo navegador.');
      this.isConnected = false;
      this.updateCloudStatusBadge('error', 'SDK Indisponível');
      return false;
    }

    try {
      this.client = window.supabase.createClient(url.trim(), key.trim(), {
        auth: { persistSession: false }
      });

      // Testa leitura simples
      const { error } = await this.client.from('equipamentos').select('id', { count: 'exact', head: true });

      if (error) {
        console.warn('Erro ao conectar ao Supabase:', error.message);
        this.isConnected = false;
        this.updateCloudStatusBadge('error', 'Erro de Conexão');
        return false;
      }

      this.isConnected = true;
      this.updateCloudStatusBadge('connected', 'Nuvem Ativa');

      // Puxa os dados mais recentes da nuvem na inicialização
      await this.pullAllFromCloud({ silent: true });

      // Inicia escuta em tempo real (Realtime WebSocket)
      this.setupRealtime();

      return true;
    } catch (err) {
      console.error('Falha de inicialização Supabase:', err);
      this.isConnected = false;
      this.updateCloudStatusBadge('error', 'Falha na Nuvem');
      return false;
    }
  },

  // Atualiza indicadores visuais de status na Topbar e em Configurações
  updateCloudStatusBadge(status, text) {
    const badge = document.getElementById('cloudStatusBadge');
    if (badge) {
      badge.className = `cloud-status-badge ${status}`;
      const textEl = badge.querySelector('.cloud-status-text');
      if (textEl) textEl.textContent = text;
      badge.title = `Supabase: ${text}`;
    }

    const configBadge = document.getElementById('supabaseConfigBadge');
    if (configBadge) {
      configBadge.className = `status-pill status-${status}`;
      configBadge.textContent = text;
    }
  },

  // Testa conexão com credenciais informadas pelo usuário
  async testConnection(url, key) {
    if (!url || !key) {
      return { success: false, message: 'Informe a URL e a Chave Anon do projeto Supabase.' };
    }

    if (!window.supabase) {
      return { success: false, message: 'Biblioteca do Supabase não carregada. Verifique sua conexão com a internet.' };
    }

    try {
      const testClient = window.supabase.createClient(url.trim(), key.trim(), {
        auth: { persistSession: false }
      });

      const { error } = await testClient.from('equipamentos').select('id', { count: 'exact', head: true });

      if (error) {
        if (error.code === '42P01') {
          return {
            success: false,
            message: 'Conexão realizada, mas as tabelas ainda não foram criadas! Execute o script SQL no Supabase.'
          };
        }
        return { success: false, message: `Erro retornado pelo Supabase: ${error.message}` };
      }

      return { success: true, message: 'Conexão com o Supabase estabelecida com sucesso!' };
    } catch (err) {
      return { success: false, message: `Erro ao testar: ${err.message}` };
    }
  },

  // Salva credenciais e conecta
  async saveConfig(url, key) {
    if (!url || !key) {
      showToast('Por favor, preencha a URL e a Chave Anon.', 'error');
      return false;
    }

    const test = await this.testConnection(url, key);
    if (!test.success) {
      showToast(test.message, 'error');
      return false;
    }

    localStorage.setItem(SUPABASE_STORAGE_URL_KEY, url.trim());
    localStorage.setItem(SUPABASE_STORAGE_ANON_KEY, key.trim());
    localStorage.setItem(SUPABASE_STORAGE_ENABLED, 'true');

    await this.init();
    showToast('Supabase conectado com sucesso! Sincronização em tempo real ativada.', 'success');
    return true;
  },

  // Desconecta e volta para modo local
  disconnect() {
    if (this.subscription) {
      this.client?.removeChannel(this.subscription);
      this.subscription = null;
    }
    localStorage.removeItem(SUPABASE_STORAGE_URL_KEY);
    localStorage.removeItem(SUPABASE_STORAGE_ANON_KEY);
    localStorage.removeItem(LEGACY_STORAGE_URL_KEY);
    localStorage.removeItem(LEGACY_STORAGE_ANON_KEY);
    localStorage.setItem(SUPABASE_STORAGE_ENABLED, 'false');
    this.client = null;
    this.isConnected = false;
    this.updateCloudStatusBadge('local', 'Modo Local');
    showToast('Desconectado do Supabase. O sistema está operando em Modo Local.', 'info');
  },

  // Configura canais Realtime para receber alterações feitas em outros aparelhos
  setupRealtime() {
    if (!this.client || !this.isConnected) return;

    if (this.subscription) {
      this.client.removeChannel(this.subscription);
    }

    this.subscription = this.client
      .channel('invbecs-realtime-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'equipamentos' }, (payload) => {
        this.handleRemoteChange('equipamentos', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'colaboradores' }, (payload) => {
        this.handleRemoteChange('colaboradores', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'movimentacoes' }, (payload) => {
        this.handleRemoteChange('movimentacoes', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'manutencoes' }, (payload) => {
        this.handleRemoteChange('manutencoes', payload);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sistema_meta' }, (payload) => {
        this.handleRemoteMetadata(payload);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Supabase Realtime ativo: escutando alterações.');
        }
      });
  },

  // Trata alterações remotas recebidas de outro aparelho (celular/PC)
  handleRemoteChange(collection, payload) {
    if (!DB[collection]) return;
    const { eventType, new: newRec, old: oldRec } = payload;

    if (eventType === 'INSERT') {
      const exists = DB[collection].some(item => Number(item.id) === Number(newRec.id));
      if (!exists) {
        DB[collection].unshift(newRec);
        saveDB(DB);
        if (typeof refreshAll === 'function') refreshAll();
        showToast(`Novo item recebido da nuvem em ${collection}!`, 'info');
      }
    } else if (eventType === 'UPDATE') {
      const idx = DB[collection].findIndex(item => Number(item.id) === Number(newRec.id));
      if (idx !== -1) {
        DB[collection][idx] = { ...DB[collection][idx], ...newRec };
        saveDB(DB);
        if (typeof refreshAll === 'function') refreshAll();
      }
    } else if (eventType === 'DELETE') {
      const targetId = Number(oldRec.id);
      DB[collection] = DB[collection].filter(item => Number(item.id) !== targetId);
      saveDB(DB);
      if (typeof refreshAll === 'function') refreshAll();
      showToast(`Item excluído na nuvem em ${collection}.`, 'info');
    }
  },

  handleRemoteMetadata(payload) {
    const { new: newRec } = payload;
    if (!newRec || !newRec.chave) return;

    if (newRec.chave === 'localizacoes' && Array.isArray(newRec.valor)) {
      DB.localizacoes = newRec.valor;
    } else if (newRec.chave === 'setores' && Array.isArray(newRec.valor)) {
      DB.setores = newRec.valor;
    } else if (newRec.chave === 'config' && typeof newRec.valor === 'object') {
      DB.config = { ...DB.config, ...newRec.valor };
    }
    saveDB(DB);
    if (typeof refreshAll === 'function') refreshAll();
  },

  // Puxa todos os dados do Supabase e substitui o DB local
  async pullAllFromCloud(options = {}) {
    if (!this.client || !this.isConnected) return;
    this.isSyncing = true;
    this.updateCloudStatusBadge('connecting', 'Sincronizando...');

    try {
      const [equipsRes, colabsRes, movsRes, manusRes, metaRes, ativRes] = await Promise.all([
        this.client.from('equipamentos').select('*').order('id', { ascending: false }),
        this.client.from('colaboradores').select('*').order('id', { ascending: false }),
        this.client.from('movimentacoes').select('*').order('id', { ascending: false }),
        this.client.from('manutencoes').select('*').order('id', { ascending: false }),
        this.client.from('sistema_meta').select('*'),
        this.client.from('atividades').select('*').order('time', { ascending: false }).limit(50)
      ]);

      if (equipsRes.data) DB.equipamentos = equipsRes.data;
      if (colabsRes.data) DB.colaboradores = colabsRes.data;
      if (movsRes.data) DB.movimentacoes = movsRes.data;
      if (manusRes.data) DB.manutencoes = manusRes.data;

      // Metadados
      if (metaRes.data) {
        for (const row of metaRes.data) {
          if (row.chave === 'localizacoes' && Array.isArray(row.valor)) DB.localizacoes = row.valor;
          if (row.chave === 'setores' && Array.isArray(row.valor)) DB.setores = row.valor;
          if (row.chave === 'config' && typeof row.valor === 'object') {
            // Preserva autenticação local se não houver na nuvem
            const localAuth = DB.config?.auth;
            DB.config = { ...DB.config, ...row.valor };
            if (!DB.config.auth && localAuth) DB.config.auth = localAuth;
          }
        }
      }

      if (ativRes.data && ativRes.data.length > 0) {
        DB.actividades = ativRes.data;
      }

      // Calcula próximos IDs
      const maxEquip = DB.equipamentos.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
      const maxColab = DB.colaboradores.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
      const maxMov = DB.movimentacoes.reduce((m, mov) => Math.max(m, Number(mov.id) || 0), 0);
      const maxManu = DB.manutencoes.reduce((m, manu) => Math.max(m, Number(manu.id) || 0), 0);

      DB.nextEquipId = maxEquip + 1;
      DB.nextColabId = maxColab + 1;
      DB.nextMovId = maxMov + 1;
      DB.nextManuId = maxManu + 1;

      saveDB(DB);

      if (typeof refreshAll === 'function') refreshAll();

      this.updateCloudStatusBadge('connected', 'Nuvem Ativa');

      if (!options.silent) {
        showToast('Dados sincronizados da nuvem com sucesso!', 'success');
      }
    } catch (err) {
      console.error('Erro ao puxar dados do Supabase:', err);
      this.updateCloudStatusBadge('error', 'Erro ao Sincronizar');
      if (!options.silent) {
        showToast(`Erro ao baixar da nuvem: ${err.message}`, 'error');
      }
    } finally {
      this.isSyncing = false;
    }
  },

  // Sobe todos os dados locais atuais para o Supabase (Migração inicial)
  async pushAllToCloud() {
    if (!this.client || !this.isConnected) {
      showToast('Supabase não conectado. Configure e teste a conexão primeiro.', 'error');
      return;
    }

    this.isSyncing = true;
    this.updateCloudStatusBadge('connecting', 'Enviando...');

    try {
      let totalEnviado = 0;

      // 1. Equipamentos
      if (DB.equipamentos && DB.equipamentos.length > 0) {
        const payload = DB.equipamentos.map(e => ({
          ...e,
          id: Number(e.id),
          valor: Number(e.valor) || 0
        }));
        const { error } = await this.client.from('equipamentos').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(`Equipamentos: ${error.message}`);
        totalEnviado += payload.length;
      }

      // 2. Colaboradores
      if (DB.colaboradores && DB.colaboradores.length > 0) {
        const payload = DB.colaboradores.map(c => ({ ...c, id: Number(c.id) }));
        const { error } = await this.client.from('colaboradores').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(`Colaboradores: ${error.message}`);
        totalEnviado += payload.length;
      }

      // 3. Movimentações
      if (DB.movimentacoes && DB.movimentacoes.length > 0) {
        const payload = DB.movimentacoes.map(m => ({
          ...m,
          id: Number(m.id),
          equipamentoId: m.equipamentoId ? Number(m.equipamentoId) : null
        }));
        const { error } = await this.client.from('movimentacoes').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(`Movimentações: ${error.message}`);
        totalEnviado += payload.length;
      }

      // 4. Manutenções
      if (DB.manutencoes && DB.manutencoes.length > 0) {
        const payload = DB.manutencoes.map(m => ({
          ...m,
          id: Number(m.id),
          equipamentoId: m.equipamentoId ? Number(m.equipamentoId) : null,
          custo: Number(m.custo) || 0
        }));
        const { error } = await this.client.from('manutencoes').upsert(payload, { onConflict: 'id' });
        if (error) throw new Error(`Manutenções: ${error.message}`);
        totalEnviado += payload.length;
      }

      // 5. Metadados (Localizações, Setores, Config)
      const metaRows = [
        { chave: 'localizacoes', valor: DB.localizacoes || [] },
        { chave: 'setores', valor: DB.setores || [] },
        { chave: 'config', valor: { nome: DB.config?.nome, empresa: DB.config?.empresa, setor: DB.config?.setor } }
      ];
      await this.client.from('sistema_meta').upsert(metaRows, { onConflict: 'chave' });

      // 6. Atividades
      if (DB.actividades && DB.actividades.length > 0) {
        const payload = DB.actividades.slice(0, 50).map((a, i) => ({
          id: a.id || `act_${Date.now()}_${i}`,
          text: a.text,
          type: a.type,
          time: a.time || new Date().toISOString()
        }));
        await this.client.from('atividades').upsert(payload, { onConflict: 'id' });
      }

      this.updateCloudStatusBadge('connected', 'Nuvem Ativa');
      showToast(`Migração concluída! ${totalEnviado} registros sincronizados na nuvem.`, 'success');
    } catch (err) {
      console.error('Erro na migração para Supabase:', err);
      this.updateCloudStatusBadge('error', 'Erro no Envio');
      showToast(`Falha ao subir dados: ${err.message}`, 'error');
    } finally {
      this.isSyncing = false;
    }
  },

  // ----------------------------------------------------
  // Operações CRUD individuais em segundo plano
  // ----------------------------------------------------
  async syncEquipamento(equip) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = { ...equip, id: Number(equip.id), valor: Number(equip.valor) || 0 };
      await this.client.from('equipamentos').upsert(payload, { onConflict: 'id' });
    } catch (err) {
      console.warn('Supabase syncEquipamento erro:', err);
    }
  },

  async deleteEquipamento(id) {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.from('equipamentos').delete().eq('id', Number(id));
    } catch (err) {
      console.warn('Supabase deleteEquipamento erro:', err);
    }
  },

  async syncColaborador(colab) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = { ...colab, id: Number(colab.id) };
      await this.client.from('colaboradores').upsert(payload, { onConflict: 'id' });
    } catch (err) {
      console.warn('Supabase syncColaborador erro:', err);
    }
  },

  async deleteColaborador(id) {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.from('colaboradores').delete().eq('id', Number(id));
    } catch (err) {
      console.warn('Supabase deleteColaborador erro:', err);
    }
  },

  async syncMovimentacao(mov) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = {
        ...mov,
        id: Number(mov.id),
        equipamentoId: mov.equipamentoId ? Number(mov.equipamentoId) : null
      };
      await this.client.from('movimentacoes').upsert(payload, { onConflict: 'id' });
    } catch (err) {
      console.warn('Supabase syncMovimentacao erro:', err);
    }
  },

  async deleteMovimentacao(id) {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.from('movimentacoes').delete().eq('id', Number(id));
    } catch (err) {
      console.warn('Supabase deleteMovimentacao erro:', err);
    }
  },

  async syncManutencao(manu) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = {
        ...manu,
        id: Number(manu.id),
        equipamentoId: manu.equipamentoId ? Number(manu.equipamentoId) : null,
        custo: Number(manu.custo) || 0
      };
      await this.client.from('manutencoes').upsert(payload, { onConflict: 'id' });
    } catch (err) {
      console.warn('Supabase syncManutencao erro:', err);
    }
  },

  async deleteManutencao(id) {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.from('manutencoes').delete().eq('id', Number(id));
    } catch (err) {
      console.warn('Supabase deleteManutencao erro:', err);
    }
  },

  async syncMetadata(chave, valor) {
    if (!this.client || !this.isConnected) return;
    try {
      await this.client.from('sistema_meta').upsert({ chave, valor }, { onConflict: 'chave' });
    } catch (err) {
      console.warn(`Supabase syncMetadata ${chave} erro:`, err);
    }
  },

  async syncAtividade(atividade) {
    if (!this.client || !this.isConnected) return;
    try {
      const payload = {
        id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        text: atividade.text,
        type: atividade.type,
        time: atividade.time || new Date().toISOString()
      };
      await this.client.from('atividades').insert(payload);
    } catch (err) {
      console.warn('Supabase syncAtividade erro:', err);
    }
  }
};
