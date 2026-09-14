# Dare Stunts PC

Jogo de corridas em primeira pessoa para **browser em PC**, ao estilo do
*Stunts* (MS-DOS, 1990): loops, corkscrews, saltos e túneis, contra o relógio.

Sem dependências. Sem npm, sem frameworks, sem bibliotecas — WebGL puro para o
mundo 3D, Canvas 2D para o cockpit e Web Audio sintetizado para o som.

Derivado de [Dare Stunts TV](https://github.com/santosvhs72-design/Dare-Stunts-TV),
que por sua vez vem de [Dare Stunts](https://github.com/santosvhs72-design/Dare-Stunts).
A física, as pistas, o construtor, os fantasmas e os recordes vieram de lá
inteiros. O que muda é a imagem — e, desde a versão 0.2, uma coisa que não é
imagem: pode-se correr contra um adversário em vez de contra o relógio.

## Porquê um repositório à parte

A versão para televisão é **WebGL 1, um shader, um passe**, de propósito: corre
numa `WebView` de TV, onde uma tentativa de iluminação dinâmica — um único farol
e um brilho especular — chegou a ser feita e teve de ser revertida por deixar o
jogo injogável no aparelho real.

Num PC essa restrição não existe, e o que ela custava via-se: nada assentava no
chão. As árvores, os pilares, os viadutos e o carro flutuavam, porque não havia
uma única sombra em lado nenhum. Aqui é WebGL 2 e vários passes.

## Por onde vai

Por ordem do que mais se nota:

1. ~~**Sombras**~~ — feito: shadow map direccional em dois mapas.
2. ~~**Iluminação por fragmento**~~ — feito: faróis, brilho de sol na estrada, e
   túneis e interiores de loops verdadeiramente escuros.
3. ~~**Anti-aliasing e pós-processamento**~~ — feito: quatro amostras de
   multisampling, curva de realces e *bloom*.
4. **Céu e neblina melhores** — neblina por distância a sério em vez de por
   profundidade de vista, e a cor da neblina a vir do próprio céu na direcção
   em que se olha, em vez de ser mantida igual ao horizonte à mão.
5. **Efeitos** — reflexo de estrada molhada, pó nas bermas, marcas de travagem.

Uma coisa que o adversário ainda não tem: **linha de corrida**. Conduz o meio
da estrada e trava para o que vem a seguir, e é só isso. É por aqui que ele
ficará mais rápido, e está medido quanto vale: a linha que minimiza a
curvatura dentro da largura da pista alivia a curva mais fechada em 0% na
Costa Verde (as curvas já são abertas de mais para a largura contar), 4% na
Vertigem e 11% na Serra Alta.

Duas coisas a fazer que não estão nesta lista: as luzes do tecto de um túnel
deviam ser emissivas e brilhar, e para isso precisam de ser uma malha à parte
da abóbada onde estão hoje embutidas; e a interface tem de deixar de ser a da
televisão.

## Correr

Não há nada para compilar. Serve a raiz por HTTP e abre-a no browser — os
módulos ES exigem um contexto seguro, e `file://` não é um:

```sh
python3 -m http.server 8765
```

## Instalar

O jogo é uma PWA: no browser, **Instalar** aparece no menu inicial assim que o
browser decidir que ele se qualifica, e passa a abrir em ecrã inteiro sem
browser à volta. Não é o jogo que decide isso — é o browser, e por isso a
entrada só existe quando há de facto alguma coisa para instalar.

Depois da primeira visita funciona **sem rede**: não há servidor nenhum do lado
de lá, e nunca houve. As pistas, os recordes e os fantasmas estão todos no
browser.

O service worker é *network-first*: online serve sempre o que está no disco, e
só cai para a cópia guardada quando não há rede. Cache-first arrancaria um
pouco mais depressa e serviria os módulos de ontem depois de cada alteração,
que num repositório cujo assunto é mudar o aspecto das coisas é uma tarde
garantida a perseguir um bug já corrigido.

A lista de ficheiros em `sw.js` é escrita à mão e há-de ficar desactualizada,
por isso nada depende de ela estar completa: um ficheiro que falte é guardado
na primeira vez que o jogo o pedir, e um que já não exista é saltado em vez de
deitar a instalação abaixo.

## Corrida ou contra o relógio

Cada pista pode ser corrida das duas maneiras, e a escolha fica guardada por
pista e por perfil, como o número de voltas: no ecrã das pistas, **↓** abre o
menu e **Modo** alterna entre as duas.

Contra o relógio é o jogo como sempre foi, com o fantasma do recordista se
houver um. Numa corrida há um carro na pista contigo, conduzido pelo mesmo
condutor de referência que o construtor usa para decidir se uma pista que
construíste é possível de todo (`js/game/driver.js`). É um carro a sério, com
a mesma física que o teu: pode ser travado, encosta-se para o lado quando
chegas ao lado dele, e se lhe tocares sentem-no os dois.

Quão duro ele é escolhe-se no mesmo menu, em **Adversário**, e a escolha fica
com o perfil e não com a pista. Com o carro do meio, nas três pistas de
fábrica:

Enquanto não houver recorde teu na pista, com o carro do meio:

| | Costa Verde | Serra Alta | Vertigem |
|---|---|---|---|
| ameno | 1:34 | 1:56 | 1:49 |
| rápido *(por omissão)* | 1:23 | 1:43 | 1:36 |
| impiedoso | 1:16 | 1:34 | 1:27 |

**A partir do momento em que tens um recorde na pista com esse carro, é esse o
alvo do adversário**, com uma folga por nível: 1%, 5% ou 12% acima do teu
melhor. É a melhor resposta que existe à pergunta "o que é uma volta boa
aqui", e faz o adversário subir contigo. Nunca mais devagar do que a tabela
acima, e nunca mais rápido do que o **impiedoso**, que é tudo o que o condutor
de referência tem nessa pista com esse carro. Para passar daí é preciso
ensiná-lo a conduzir melhor, não a arriscar mais — a arriscar mais já não
rende nada.

## Comandos

↑/W acelera, ↓/S trava, ←→/AD viram, Espaço é o travão de mão. Nos menus, as
setas navegam e Enter escolhe. Um comando de jogo também funciona: RT acelera,
LT trava, stick esquerdo vira, A é o travão de mão.

## Cruzamentos

Uma pista pode passar por cima de si própria — o mundo põe pilares e faz-se um
viaduto — e agora também pode **cruzar-se ao nível do chão**. Uma figura de
oito é o traçado de circuito mais antigo que há, e o construtor fecha
circuitos por um cruzamento sem hesitar.

O que isso exige é que as duas estradas larguem as bordas onde se encontram:
cada troço leva berma, barreira e saia dos dois lados, e duas fitas a
encontrarem-se ao mesmo nível punham quatro paredes atravessadas uma na outra.
O carro chegava lá a 200 km/h e batia numa barreira no meio da estrada. Onde
há cruzamento as bordas terminam antes e recomeçam depois, e o alcatrão de uma
delas cede para as duas não brigarem pelo mesmo chão.

## O cenário

Árvores, postes de berma e colinas ao longe vieram da versão para televisão.
Deste lado juntam-se **vacas** e **casas de campo** — uma vacaria a cada cento
e tal metros, uma casa ou um celeiro a cada duzentos e muitos, bem afastados
da estrada e virados para onde lhes apetece. São raras de propósito: uma vaca
só funciona enquanto se dá por ela.

## Como está feito

O `Renderer` recebe uma **descrição da cena**, não uma sequência de chamadas.
Na versão para televisão o `Game.render` desenhava — `beginFrame` e depois um
`draw` por grupo — e o renderer nunca via a cena inteira. Um mapa de sombras
tem de percorrer a mesma geometria outra vez, de outro sítio, antes de alguma
coisa chegar ao ecrã, por isso a lista do que há para desenhar tem de existir
antes de o desenho começar. É a única coisa que o motor de jogo cedeu.

Um frame são quatro andares: os dois mapas de sombras, a cena para um buffer
`RGBA16F` com quatro amostras, a resolução dessas amostras, e a composição no
ecrã. O multisampling é pedido à mão porque um browser só multisamplia a
imagem que mostra directamente, e a partir do momento em que o frame é
construído por etapas essa imagem é uma textura.

Quatro decisões que não são óbvias e que é bom não desfazer sem saber porquê:

- **Há um único preâmbulo de GLSL, `highp` nos dois estágios, à cabeça de todos
  os shaders.** É estrutural, não zelo: um uniform lido pelos dois estágios tem
  de ser declarado com a mesma precisão nos dois ou o programa recusa-se a
  ligar, e nada na mensagem de erro diz isso. Um vertex shader sem directiva
  `precision` própria é `highp` por omissão da linguagem, um fragment shader
  que diga `mediump` não é, e foi assim que a versão para televisão perdeu uma
  tarde. Com um preâmbulo só não sobra nenhuma declaração que possa discordar
  de outra.
- **O piso ambiente é baixo, e o sol soma-se por cima dele.** A fórmula
  herdada somava o sol *dentro* de um piso alto, o que deixava uma superfície
  ao sol e a mesma sem sol nenhum a 11% uma da outra. Servia para um mundo sem
  sombras, onde o trabalho era tudo continuar legível; num mundo com sombras
  não sobra nada para a sombra fazer. Ao sol a imagem está a poucos por cento
  de onde sempre esteve, à sombra um terço abaixo — e o interior de um loop e
  o furo de um túnel, onde o sol nunca chegou, ficaram muito mais escuros de
  propósito. É por isso que os faróis tinham de existir primeiro.
- **A caixa de cada mapa de sombras é arredondada a texels inteiros.** Sem
  isso desliza uma fracção de texel por frame enquanto o carro anda, cada
  aresta é redesenhada contra uma grelha diferente, e o mundo inteiro ferve.
- **Os termos de luz novos iluminam o lado da face virado para a câmara; os
  antigos continuam a ler a normal como sempre leram.** O culling está
  desligado de propósito — a fita conduz-se dos dois lados — e o sentido da
  normal de um quad é o que o construtor da malha lhe deu, que para o arco de
  um túnel muda a meio. Ao sol isso era indiferente; a uma lâmpada a dois
  metros da parede não é.

Para desenvolver, vale a pena servir com `Cache-Control: no-store`: os módulos
ES ficam em cache com muita vontade, e uma alteração a um shader que o browser
não recarrega é meia hora a perseguir um bug que já está corrigido.

`window.__game()` entrega o jogo a quem o queira conduzir de fora. Comparar
duas versões da mesma imagem exige chegar duas vezes exactamente ao mesmo
sítio da pista, e a conduzir à mão isso não acontece. As vistas de referência
usadas até agora são da Costa Verde: a recta com as árvores aos 100 m, a
entrada do túnel aos 470, e a rampa do loop aos 2080.
