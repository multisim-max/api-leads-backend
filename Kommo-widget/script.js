define(['jquery'], function($) { // O Kommo usa jQuery e AMD (define)
  return function() {
    var self = this; // Referência ao widget

    this.callbacks = {
      render: function() {
        // Esta função é chamada quando o widget precisa ser desenhado
        console.log('ASN WebConnect Widget: Renderizando...');
        
        // A URL do seu painel na Vercel
        var iframeUrl = 'https://asn-asmin-widget.vercel.app/'; 
        
        // Cria o iframe
        var iframe = '<iframe src="' + iframeUrl + '" style="width: 100%; height: 80vh; border: none;"></iframe>';
        
        // Encontra a área de trabalho do widget (o Kommo deve fornecer isso)
        // e insere o iframe. O seletor '.work-area-content' é um palpite comum.
        // Se não funcionar, teremos que achar o seletor correto na documentação ou inspecionando o Kommo.
        $('.work-area-content').html(iframe); 
        
        return true; // Indica que o render foi bem-sucedido
      },
      init: function() {
        // Chamado uma vez quando o widget é inicializado
        console.log('ASN WebConnect Widget: Inicializado!');
        return true;
      },
      bind_actions: function() {
        // Chamado para adicionar listeners de eventos (não precisamos agora)
        return true;
      },
      settings: function() {
        // Chamado quando a janela modal de configurações é aberta (se houver)
        // Como nossas configurações estão no Vercel, não precisamos fazer nada aqui.
        // A função 'render' já cuida de mostrar nosso painel.
        return true;
      },
      onSave: function() {
        // Chamado quando o usuário clica em Salvar nas configurações do Kommo
        // (não relevante para nós, pois salvamos dentro do iframe)
        return true;
      },
      destroy: function() {
        // Chamado quando o widget é desativado/desinstalado
        return true;
      }
    }; // fim callbacks

    return this;
  }; // fim função principal
}); // fim define